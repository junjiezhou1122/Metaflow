import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { ContextStore } from "@info/core";
import { createContextHttpHandler } from "@info/server/http-server.js";

async function withStore(fn: (store: ContextStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "info-http-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  const oldBrowserAmbientRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  const restoreBrowserAmbientAgents = suppressBrowserAmbientAgents();
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME ??= "local_mock";
  return Promise.resolve(fn(store)).finally(() => {
    restoreBrowserAmbientAgents();
    if (oldBrowserAmbientRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldBrowserAmbientRuntime;
    rmSync(dir, { recursive: true, force: true });
  });
}

function suppressBrowserAmbientAgents() {
  const oldBrowserAmbientAgent = process.env.BROWSER_AMBIENT_AGENT;
  const oldInfoBrowserAmbientAgent = process.env.INFO_BROWSER_AMBIENT_AGENT;
  process.env.BROWSER_AMBIENT_AGENT = "0";
  process.env.INFO_BROWSER_AMBIENT_AGENT = "0";
  return () => {
    if (oldBrowserAmbientAgent === undefined) delete process.env.BROWSER_AMBIENT_AGENT;
    else process.env.BROWSER_AMBIENT_AGENT = oldBrowserAmbientAgent;
    if (oldInfoBrowserAmbientAgent === undefined) delete process.env.INFO_BROWSER_AMBIENT_AGENT;
    else process.env.INFO_BROWSER_AMBIENT_AGENT = oldInfoBrowserAmbientAgent;
  };
}

async function request(store: ContextStore, path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const text = options.body === undefined ? "" : JSON.stringify(options.body);
  const req = Readable.from(text ? [text] : []) as any;
  req.method = options.method ?? "GET";
  req.url = path;
  req.headers = { host: "localhost", "content-type": "application/json" };
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      raw = value;
    },
  };
  await createContextHttpHandler(store)(req, res);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

test("POST /feedback lets Applications write feedback Observations", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-feedback-view",
    view_type: "analysis.browser_page",
    content: { analysis: "feedback target" },
  });

  const response = await request(store, "/feedback", {
    method: "POST",
    body: {
      type: "analysis.dismissed",
      application_id: "browser.sidebar",
      view_id: "analysis:http-feedback-view",
      value: "dismissed",
      reason: "not useful in this context",
      payload: { surface: "sidebar" },
    },
  });
  const body = response.body as { ok: boolean; record: { id: string; schema: { name: string }; source: { type: string; connector: string }; relations: { related_to: string[] }; payload: Record<string, unknown> } };

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.record.schema.name, "feedback.analysis.dismissed");
  assert.equal(body.record.source.type, "application");
  assert.equal(body.record.source.connector, "browser.sidebar");
  assert.deepEqual(body.record.relations.related_to, ["analysis:http-feedback-view"]);
  assert.equal(body.record.payload.value, "dismissed");
  assert.equal(body.record.payload.surface, "sidebar");

  const event = store.listRuntimeEvents({ event_type: "feedback.received", subject_id: body.record.id, limit: 1 })[0];
  assert.ok(event);
  assert.equal(event.actor, "user");
  assert.deepEqual(event.related_views, ["analysis:http-feedback-view"]);
}));

test("POST /feedback rejects missing related View or Observation targets", async () => withStore(async (store) => {
  const missingView = await request(store, "/feedback", {
    method: "POST",
    body: {
      type: "analysis.dismissed",
      application_id: "browser.popup",
      view_id: "analysis:missing-feedback-target",
      value: "dismissed",
    },
  });

  assert.equal(missingView.status, 404);
  assert.equal(missingView.body.ok, false);
  assert.equal(missingView.body.error, "feedback target view not found");
  assert.equal(store.recent(10).length, 0);

  const missingRecord = await request(store, "/feedback", {
    method: "POST",
    body: {
      type: "routing.confirmed",
      application_id: "browser.popup",
      record_id: "record:missing-feedback-target",
      value: "confirmed",
    },
  });

  assert.equal(missingRecord.status, 404);
  assert.equal(missingRecord.body.ok, false);
  assert.equal(missingRecord.body.error, "feedback target record not found");
  assert.equal(store.recent(10).length, 0);
}));

test("GET /agent/tasks exposes the unified agent task list View", async () => withStore(async (store) => {
  const source = store.insertRecord({
    id: "record:http-agent-task-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "HTTP agent task source" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:background-research:http",
    view_type: "task.background_research",
    title: "HTTP queued research",
    source_records: [source.id],
    content: { focus: "HTTP task surface", goal: "Expose agent task list over HTTP." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/agent/tasks?refresh=true");
  const body = response.body as {
    ok: boolean;
    task_list: { counts: Record<string, number>; items: Array<{ id: string; view_type: string; status: string }> };
    view: { id: string; view_type: string } | null;
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.task_list.counts.candidate, 1);
  assert.deepEqual(body.task_list.items.map(item => [item.id, item.view_type, item.status]), [
    ["task:background-research:http", "task.background_research", "candidate"],
  ]);
  assert.equal(body.view?.id, "agent:task_list:current");
  assert.equal(body.view?.view_type, "agent.task_list");
}));

test("POST /agent/tasks queues and processes tasks through the HTTP contract", async () => withStore(async (store) => {
  const source = store.insertRecord({
    id: "record:http-agent-task-process-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "HTTP process task source", text: "Process this with local mock." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:background-research:http-process",
    view_type: "task.background_research",
    title: "HTTP process research",
    source_records: [source.id],
    content: { focus: "HTTP task processing", goal: "Produce a background research brief." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/agent/tasks", {
    method: "POST",
    body: { mode: "process", runtime: "local_mock", limit: 1 },
  });
  const body = response.body as {
    ok: boolean;
    processed: number;
    task_list: { counts: Record<string, number>; items: Array<{ id: string; status: string; runtime?: string }> };
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.processed, 1);
  assert.equal(body.task_list.counts.completed, 1);
  assert.equal(body.task_list.items[0]?.id, "task:background-research:http-process");
  assert.equal(body.task_list.items[0]?.status, "completed");
  assert.equal(body.task_list.items[0]?.runtime, "local_mock");
  assert.ok(store.listViews({ view_types: ["brief.background_research"], limit: 5 }).length >= 1);
}));

test("GET /processors lists compatible processors for a source type", async () => withStore(async (store) => {
  const response = await request(store, "/processors?source_kind=observation&source_type=observation.screenpipe_activity");
  const body = response.body as { ok: boolean; processors: Array<{ id: string; consumes: { observations?: string[] }; produces: { views?: string[] }; compatible?: boolean }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.processors.some(processor => processor.id === "processor.screenpipe_surface"));
  assert.ok(body.processors.every(processor => processor.compatible !== false));
}));

test("POST /processors/run creates Views from an Observation input", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-processor-screenpipe",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe" },
    content: {
      app_name: "Cursor",
      window_name: "info - Cursor",
      ocr_text: "Implement dynamic processor-created views.",
    },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/processors/run", {
    method: "POST",
    body: { processor_id: "processor.screenpipe_surface", record_id: record.id },
  });
  const body = response.body as { ok: boolean; result: { views_written: string[] }; views: Array<{ id: string; view_type: string; source_records?: string[] }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.views.length, 1);
  assert.equal(body.views[0].view_type, "screenpipe.surface");
  assert.ok(body.views[0].source_records?.includes(record.id));
  assert.deepEqual(body.result.views_written, [body.views[0].id]);
}));

test("POST /agent/tasks rejects plugin-scoped queue or process requests", async () => withStore(async (store) => {
  const response = await request(store, "/agent/tasks?plugin_id=external-agent", {
    method: "POST",
    body: { mode: "queue" },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "plugins cannot queue or process agent tasks");
  assert.equal(response.body.plugin_id, "external-agent");
}));

test("POST /agent/tasks/:id can cancel and retry a task view", async () => withStore(async (store) => {
  const source = store.insertRecord({
    id: "record:http-agent-task-lifecycle-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "HTTP agent task lifecycle source" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:background-research:http-lifecycle",
    view_type: "task.background_research",
    title: "HTTP lifecycle research",
    source_records: [source.id],
    content: { goal: "Exercise lifecycle actions" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const cancelled = await request(store, "/agent/tasks/task%3Abackground-research%3Ahttp-lifecycle", {
    method: "POST",
    body: { action: "cancel", reason: "not needed" },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.ok, true);
  assert.equal(cancelled.body.view.content.background_task.status, "cancelled");
  assert.equal(cancelled.body.task_list.counts.cancelled, 1);

  const retried = await request(store, "/agent/tasks/task%3Abackground-research%3Ahttp-lifecycle", {
    method: "POST",
    body: { action: "retry", reason: "retry it" },
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.ok, true);
  assert.equal(retried.body.view.content.background_task.status, "queued");
  assert.equal(retried.body.task_list.counts.queued, 1);
}));

test("POST /context/chat answers through Claude ACP chat without creating AgentTask", async () => withStore(async (store) => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-info-http-chat-acp-test-"));
  const script = join(dir, "fake-chat-acp-agent.mjs");
  writeFileSync(script, fakeChatAcpAgentSource());
  const oldCommand = process.env.CONTEXT_CHAT_ACP_COMMAND;
  const oldArgs = process.env.CONTEXT_CHAT_ACP_ARGS;
  const oldTimeout = process.env.CONTEXT_CHAT_ACP_TIMEOUT_MS;
  process.env.CONTEXT_CHAT_ACP_COMMAND = process.execPath;
  process.env.CONTEXT_CHAT_ACP_ARGS = script;
  process.env.CONTEXT_CHAT_ACP_TIMEOUT_MS = "5000";
  try {
    store.insertRecord({
      id: "record:http-context-chat-source",
      schema: { name: "observation.browser_page_saved", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { domain: "example.com", app: "chrome" },
      content: { title: "Normal chat page", url: "https://example.com/chat", text: "Normal browser chat should not use AgentTask." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/context/chat", {
      method: "POST",
      body: {
        question: "What is this page about?",
        page_context: {
          title: "Normal chat page",
          url: "https://example.com/chat",
          text: "Normal browser chat should not use AgentTask.",
        },
        scope: { domain: "example.com", app: "chrome" },
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.answer, "ACP chat saw page context without AgentTask JSON.");
    assert.equal(response.body.runtime, "claude_acp");
    assert.equal(response.body.stop_reason, "end_turn");
    assert.equal(response.body.agent_info.name, "fake-chat-acp-agent");
    assert.equal(store.listViews({ view_types: ["analysis.browser_agent_task"] }).length, 0);
    assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", limit: 1 }).length, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /output_contract|next_actions|write_policy/);
  } finally {
    if (oldCommand === undefined) delete process.env.CONTEXT_CHAT_ACP_COMMAND;
    else process.env.CONTEXT_CHAT_ACP_COMMAND = oldCommand;
    if (oldArgs === undefined) delete process.env.CONTEXT_CHAT_ACP_ARGS;
    else process.env.CONTEXT_CHAT_ACP_ARGS = oldArgs;
    if (oldTimeout === undefined) delete process.env.CONTEXT_CHAT_ACP_TIMEOUT_MS;
    else process.env.CONTEXT_CHAT_ACP_TIMEOUT_MS = oldTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("POST /feedback rejects legacy non-observation Record targets", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-feedback-legacy-target",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy target", text: "LEGACY FEEDBACK TARGET SHOULD NOT BE USED" },
  });

  const response = await request(store, "/feedback", {
    method: "POST",
    body: {
      type: "routing.confirmed",
      application_id: "browser.popup",
      record_id: "record:http-feedback-legacy-target",
      value: "confirmed",
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "feedback target record not found");
  assert.doesNotMatch(JSON.stringify(response.body), /LEGACY FEEDBACK TARGET SHOULD NOT BE USED/);
  assert.equal(store.recent(10).filter(record => record.schema.name.startsWith("feedback.")).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "feedback.received", limit: 10 }).length, 0);
}));

test("POST /feedback rejects target Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-feedback-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting feedback source", text: "CONFLICTING FEEDBACK SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-feedback-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting feedback View",
    source_records: ["record:http-feedback-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING FEEDBACK VIEW SHOULD NOT TRAIN MEMORY" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "analysis.useful",
      application_id: "browser.popup",
      view_id: "analysis:http-feedback-scope-conflict",
      value: "useful",
      reason: "This dirty View must not become learning signal.",
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "feedback target view not found");
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING FEEDBACK/);
  assert.equal(store.recent(20).filter(record => record.schema.name.startsWith("feedback.")).length, 0);
  assert.equal(store.listViews({ view_types: ["memory.surfacing_preference"], limit: 10 }).length, 0);
}));

test("POST /feedback with plugin_id applies target permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-feedback-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "feedback-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "feedback-client", "plugin.json"), JSON.stringify({
      id: "feedback-client",
      name: "Feedback Client",
      permissions: {
        allowed_view_types: ["analysis.browser_page"],
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.upsertView({
      id: "analysis:http-feedback-plugin-allowed",
      view_type: "analysis.browser_page",
      content: { analysis: "allowed feedback target" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-feedback-plugin-denied",
      view_type: "analysis.browser_page",
      content: { analysis: "DENIED FEEDBACK TARGET SHOULD NOT BE WRITTEN" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const denied = await request(store, "/feedback?plugin_id=feedback-client", {
      method: "POST",
      body: {
        type: "analysis.dismissed",
        application_id: "browser.popup",
        view_id: "analysis:http-feedback-plugin-denied",
        value: "dismissed",
      },
    });
    const deniedByBodyPlugin = await request(store, "/feedback", {
      method: "POST",
      body: {
        plugin_id: "feedback-client",
        type: "analysis.dismissed",
        application_id: "browser.popup",
        view_id: "analysis:http-feedback-plugin-denied",
        value: "dismissed",
      },
    });
    const allowed = await request(store, "/feedback?plugin_id=feedback-client", {
      method: "POST",
      body: {
        type: "analysis.useful",
        application_id: "browser.popup",
        view_id: "analysis:http-feedback-plugin-allowed",
        value: "useful",
      },
    });

    assert.equal(denied.status, 403);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.error, "plugin cannot write feedback for this view");
    assert.equal(denied.body.plugin_id, "feedback-client");
    assert.equal(denied.body.plugin_loaded, true);
    assert.equal(deniedByBodyPlugin.status, 403);
    assert.equal(deniedByBodyPlugin.body.ok, false);
    assert.equal(deniedByBodyPlugin.body.error, "plugin cannot write feedback for this view");
    assert.equal(deniedByBodyPlugin.body.plugin_id, "feedback-client");
    assert.equal(deniedByBodyPlugin.body.plugin_loaded, true);

    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.ok, true);
    assert.equal(allowed.body.plugin_id, "feedback-client");
    assert.equal(allowed.body.plugin_loaded, true);
    assert.equal(allowed.body.record.scope.plugin_id, "feedback-client");
    assert.equal(allowed.body.record.payload.target_view_type, "analysis.browser_page");

    const events = store.listRuntimeEvents({ event_type: "feedback.received", plugin_id: "feedback-client", limit: 5 });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].related_views, ["analysis:http-feedback-plugin-allowed"]);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("POST /feedback with unknown plugin_id does not write unscoped feedback", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-feedback-unknown-plugin",
    view_type: "analysis.browser_page",
    content: { analysis: "UNKNOWN FEEDBACK PLUGIN SHOULD NOT TARGET THIS VIEW" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/feedback?plugin_id=missing-plugin", {
    method: "POST",
    body: {
      type: "analysis.useful",
      application_id: "browser.popup",
      view_id: "analysis:http-feedback-unknown-plugin",
      value: "useful",
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.equal(store.recent(10).length, 0);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN FEEDBACK PLUGIN SHOULD NOT TARGET/);
}));
test("POST /feedback can process learning Programs immediately", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-feedback-process-view",
    view_type: "analysis.browser_page",
    scope: { domain: "github.com" },
    content: { analysis: "feedback process target" },
  });

  const response = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "analysis.dismissed",
      application_id: "browser.sidebar",
      view_id: "analysis:http-feedback-process-view",
      value: "dismissed",
      reason: "not useful now",
    },
  });
  const body = response.body as { ok: boolean; processing: { runs: Array<{ written_views: string[] }> } };
  const writtenViewId = body.processing.runs[0].written_views[0];
  const memory = store.getView(writtenViewId);

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(memory);
  assert.equal(memory.view_type, "memory.surfacing_preference");
  assert.equal(memory.content?.target_view_type, "analysis.browser_page");
}));

test("POST /feedback can process useful analysis into show_more surfacing memory", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-feedback-useful-view",
    view_type: "analysis.browser_agent_task",
    scope: { domain: "github.com" },
    content: { analysis: "useful feedback target" },
  });

  const response = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "analysis.useful",
      application_id: "browser.popup",
      view_id: "analysis:http-feedback-useful-view",
      value: "useful",
      reason: "this helped",
      payload: { target_view_type: "analysis.browser_agent_task", surface: "popup" },
    },
  });
  const body = response.body as { ok: boolean; record: { id: string; schema: { name: string }; payload: Record<string, unknown> }; processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
  const learningRun = body.processing.runs.find(run => run.program_id === "program.feedback_learning");
  const memory = store.getView(learningRun?.written_views[0] ?? "");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.record.schema.name, "feedback.analysis.useful");
  assert.equal(body.record.payload.target_view_type, "analysis.browser_agent_task");
  assert.ok(learningRun);
  assert.ok(memory);
  assert.equal(memory.view_type, "memory.surfacing_preference");
  assert.equal(memory.content?.preference, "show_more");
  assert.equal(memory.content?.target_view_type, "analysis.browser_agent_task");
  assert.equal(memory.content?.feedback_value, "useful");
  assert.deepEqual(memory.source_views, ["analysis:http-feedback-useful-view"]);
}));

test("POST /feedback useful memory changes future context pack selection over HTTP", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-feedback-pack-agent-task",
    view_type: "analysis.browser_agent_task",
    title: "Useful AgentTask context",
    content: { analysis: "Useful AgentTask analysis should be selected after feedback." },
    confidence: 0.82,
  });

  const feedback = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "analysis.useful",
      application_id: "browser.popup",
      view_id: "analysis:http-feedback-pack-agent-task",
      value: "useful",
      reason: "show this kind of analysis in context packs",
    },
  });
  const feedbackBody = feedback.body as { ok: boolean; processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
  const learningRun = feedbackBody.processing.runs.find(run => run.program_id === "program.feedback_learning");
  const memoryId = learningRun?.written_views[0];

  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-feedback-pack-repo-newer",
    view_type: "analysis.repo",
    title: "Newer repo analysis",
    content: { analysis: "Newer repo analysis should not win over useful AgentTask type." },
  });

  const pack = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "analysis",
      include_views: true,
      view_type_prefix: "analysis.",
      limit: 1,
    },
  });

  assert.equal(feedback.status, 201);
  assert.equal(feedbackBody.ok, true);
  assert.ok(memoryId);
  assert.equal(store.getView(memoryId)?.content?.preference, "show_more");
  assert.equal(pack.status, 200);
  assert.deepEqual(pack.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-feedback-pack-agent-task"]);
  assert.deepEqual(pack.body.pack.diagnostics.surfacing_preferences, {
    show_more_view_types: ["analysis.browser_agent_task"],
    show_less_view_types: [],
    source_view_ids: [memoryId],
  });
  assert.match(pack.body.pack.markdown, /Useful AgentTask analysis should be selected/);
  assert.doesNotMatch(pack.body.pack.markdown, /Newer repo analysis should not win/);
}));

test("POST /feedback useful memory changes future Browser Ambient attention over HTTP", async () => withStore(async (store) => {
  const oldAgent = process.env.BROWSER_AMBIENT_AGENT;
  const oldInfoAgent = process.env.INFO_BROWSER_AMBIENT_AGENT;
  process.env.BROWSER_AMBIENT_AGENT = "0";
  process.env.INFO_BROWSER_AMBIENT_AGENT = "0";
  try {
    store.upsertView({
      id: "analysis:http-feedback-wake-browser-agent-task",
      view_type: "analysis.browser_agent_task",
      scope: { domain: "example.com" },
      content: { analysis: "Useful analysis for example.com browser pages." },
      confidence: 0.82,
    });

    const feedback = await request(store, "/feedback?process=true", {
      method: "POST",
      body: {
        type: "analysis.useful",
        application_id: "browser.popup",
        view_id: "analysis:http-feedback-wake-browser-agent-task",
        value: "useful",
        reason: "show this kind of browser analysis more often",
      },
    });
    const feedbackBody = feedback.body as { ok: boolean; processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
    const learningRun = feedbackBody.processing.runs.find(run => run.program_id === "program.feedback_learning");
    const memoryId = learningRun?.written_views[0];

    const record = store.insertRecord({
      id: "record:http-feedback-wake-future-browser",
      schema: { name: "observation.browser_page_snapshot", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { domain: "example.com" },
      content: { title: "Personal notes", url: "https://example.com/notes", text: "Weak browser page that normally defers." },
      privacy: { level: "private", retention: "normal" },
    });

    const process = await request(store, "/programs/process", {
      method: "POST",
      body: {
        record_id: record.id,
        program_id: "program.browser_ambient",
        dry_run: true,
      },
    });
    const processBody = process.body as { decisions: Array<{ action: string; attention_influences?: unknown[] }>; diagnostics: { attention_influences?: unknown[] } };

    assert.equal(feedback.status, 201);
    assert.equal(feedbackBody.ok, true);
    assert.ok(memoryId);
    assert.equal(store.getView(memoryId)?.content?.preference, "show_more");
    assert.equal(process.status, 200);
    assert.equal(processBody.decisions[0].action, "run");
    assert.deepEqual(processBody.diagnostics.attention_influences, [
      {
        program_id: "program.browser_ambient",
        kind: "memory.surfacing_preference",
        view_id: memoryId,
        preference: "show_more",
        target_view_type: "analysis.browser_agent_task",
      },
    ]);
    assert.deepEqual(processBody.decisions[0].attention_influences, processBody.diagnostics.attention_influences);
  } finally {
    if (oldAgent === undefined) delete process.env.BROWSER_AMBIENT_AGENT;
    else process.env.BROWSER_AMBIENT_AGENT = oldAgent;
    if (oldInfoAgent === undefined) delete process.env.INFO_BROWSER_AMBIENT_AGENT;
    else process.env.INFO_BROWSER_AMBIENT_AGENT = oldInfoAgent;
  }
}));

test("POST /feedback can process routing feedback into routing.shortcut", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-routing-feedback-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "github.com" },
    content: { title: "example/repo", url: "https://github.com/example/repo", text: "Repository page." },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "routing.confirmed",
      application_id: "browser.sidebar",
      record_id: "record:http-routing-feedback-source",
      reason: "GitHub repository pages should wake Project Ambient.",
      payload: {
        program_id: "program.project_ambient",
        match: { object_kind: "observation", source: "browser", domain: "github.com" },
      },
    },
  });
  const body = response.body as { ok: boolean; record: { id: string; schema: { name: string } }; processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
  const routingRun = body.processing.runs.find(run => run.program_id === "program.routing_learning");
  const shortcut = store.getView(routingRun?.written_views[0] ?? "");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.record.schema.name, "feedback.routing.confirmed");
  assert.ok(routingRun);
  assert.ok(shortcut);
  assert.equal(shortcut.view_type, "routing.shortcut");
  assert.equal(shortcut.compiler?.id, "program.routing_learning");
  assert.deepEqual(shortcut.source_records, [body.record.id, "record:http-routing-feedback-source"]);
  assert.equal(shortcut.content?.program_id, "program.project_ambient");
  assert.deepEqual(shortcut.content?.match, { object_kind: "observation", source: "browser", domain: "github.com" });
}));

test("POST /feedback does not learn match-everything routing shortcuts", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-routing-feedback-empty-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "example/repo", text: "Repository page." },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "routing.confirmed",
      application_id: "browser.sidebar",
      record_id: "record:http-routing-feedback-empty-source",
      reason: "Empty match should not train a global shortcut.",
      payload: {
        program_id: "program.project_ambient",
        match: {},
      },
    },
  });
  const body = response.body as { ok: boolean; processing: { runs: Array<{ program_id: string; ok: boolean; reason?: string; written_views: string[] }> } };
  const routingRun = body.processing.runs.find(run => run.program_id === "program.routing_learning");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(routingRun);
  assert.equal(routingRun.ok, false);
  assert.match(routingRun.reason ?? "", /match must include at least one condition/);
  assert.deepEqual(routingRun.written_views, []);
  assert.equal(store.listViews({ view_types: ["routing.shortcut"] }).length, 0);
}));

test("POST /feedback can reject a learned routing.shortcut", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-routing-reject-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "github.com" },
    content: { title: "example/repo", url: "https://github.com/example/repo", text: "Repository page." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const payload = {
    program_id: "program.project_ambient",
    match: { object_kind: "observation", source: "browser", domain: "github.com" },
  };

  const confirm = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "routing.confirmed",
      application_id: "browser.sidebar",
      record_id: "record:http-routing-reject-source",
      reason: "Initially useful.",
      payload,
    },
  });
  const confirmBody = confirm.body as { processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
  const confirmedShortcutId = confirmBody.processing.runs.find(run => run.program_id === "program.routing_learning")?.written_views[0];
  assert.ok(confirmedShortcutId);
  assert.equal(store.getView(confirmedShortcutId)?.status, "candidate");

  const reject = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "routing.rejected",
      application_id: "browser.sidebar",
      record_id: "record:http-routing-reject-source",
      reason: "This route is noisy.",
      payload,
    },
  });
  const rejectBody = reject.body as { ok: boolean; record: { id: string; schema: { name: string } }; processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
  const rejectedShortcutId = rejectBody.processing.runs.find(run => run.program_id === "program.routing_learning")?.written_views[0];
  const rejectedShortcut = store.getView(rejectedShortcutId ?? "");

  assert.equal(reject.status, 201);
  assert.equal(rejectBody.ok, true);
  assert.equal(rejectBody.record.schema.name, "feedback.routing.rejected");
  assert.equal(rejectedShortcutId, confirmedShortcutId);
  assert.ok(rejectedShortcut);
  assert.equal(rejectedShortcut.status, "rejected");
  assert.equal(rejectedShortcut.confidence, 0.2);
  assert.equal(rejectedShortcut.content?.rejected, true);

  const process = await request(store, "/programs/process", {
    method: "POST",
    body: { record_id: "record:http-routing-reject-source", dry_run: true },
  });
  assert.equal(process.status, 200);
  assert.equal(process.body.diagnostics.routing_shortcut_view_id, undefined);
}));

test("GET /context/recent with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-recent-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-recent-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed source", text: "ALLOWED RECENT CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-recent-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied source", text: "DENIED RECENT CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/context/recent?plugin_id=external-agent&limit=10");
    const body = response.body as { ok: boolean; records: Array<{ id: string }>; plugin_id?: string; plugin_loaded?: boolean };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.records.map(record => record.id), ["record:http-recent-plugin-allowed"]);
    assert.equal(body.plugin_id, "external-agent");
    assert.equal(body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(body.records), /DENIED RECENT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("GET /context/recent with unknown plugin_id does not fall back to unscoped Observations", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-recent-unknown-plugin",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden source", text: "UNKNOWN RECENT PLUGIN SHOULD NOT SEE THIS RECORD" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/recent?plugin_id=missing-plugin&limit=10");

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN RECENT PLUGIN SHOULD NOT SEE/);
}));

test("HTTP record query endpoints hide legacy non-observation Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-legacy-derived-hidden",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy-derived" },
    content: { title: "Legacy derived", text: "LEGACY DERIVED RECORD SHOULD NOT LEAK" },
  });
  store.insertRecord({
    id: "record:http-legacy-episode-hidden",
    schema: { name: "episode.project_work", version: 1 },
    source: { type: "plugin", connector: "legacy-episode" },
    content: { title: "Legacy episode", text: "LEGACY EPISODE RECORD SHOULD NOT LEAK searchable-token" },
  });
  store.insertRecord({
    id: "record:http-raw-visible",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Raw visible", text: "RAW OBSERVATION searchable-token" },
  });

  const recent = await request(store, "/context/recent?limit=10");
  const search = await request(store, "/context/search", {
    method: "POST",
    body: { query: "searchable-token", limit: 10 },
  });
  const single = await request(store, `/context/records/${encodeURIComponent("record:http-legacy-derived-hidden")}`);

  assert.equal(recent.status, 200);
  assert.deepEqual(recent.body.records.map((record: { id: string }) => record.id), ["record:http-raw-visible"]);
  assert.doesNotMatch(JSON.stringify(recent.body), /LEGACY DERIVED|LEGACY EPISODE/);
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.records.map((record: { id: string }) => record.id), ["record:http-raw-visible"]);
  assert.doesNotMatch(JSON.stringify(search.body), /LEGACY DERIVED|LEGACY EPISODE/);
  assert.equal(single.status, 404);
  assert.equal(single.body.ok, false);
  assert.doesNotMatch(JSON.stringify(single.body), /LEGACY DERIVED/);
}));

test("GET /context/recent with plugin_id does not let hidden records starve visible Observations", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-recent-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "observation-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "observation-reader", "plugin.json"), JSON.stringify({
      id: "observation-reader",
      name: "Observation Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-recent-starvation-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Visible source", text: "VISIBLE RECENT CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertRecord({
        id: `record:http-recent-starvation-hidden-${index}`,
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser" },
        content: { title: "Hidden source", text: `HIDDEN RECENT CONTEXT ${index}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
    }

    const response = await request(store, "/context/recent?plugin_id=observation-reader&limit=5");

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.records.map((record: { id: string }) => record.id), ["record:http-recent-starvation-visible"]);
    assert.doesNotMatch(JSON.stringify(response.body.records), /HIDDEN RECENT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/search with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-search-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-search-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed source", text: "shared search token allowed" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-search-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied source", text: "shared search token DENIED SEARCH CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/context/search", {
      method: "POST",
      body: { query: "shared search token", plugin_id: "external-agent", limit: 10 },
    });
    const queryParamResponse = await request(store, "/context/search?plugin_id=external-agent", {
      method: "POST",
      body: { query: "shared search token", limit: 10 },
    });
    const body = response.body as { ok: boolean; records: Array<{ id: string }>; plugin_id?: string; plugin_loaded?: boolean };
    const queryParamBody = queryParamResponse.body as { ok: boolean; records: Array<{ id: string }>; plugin_id?: string; plugin_loaded?: boolean };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.records.map(record => record.id), ["record:http-search-plugin-allowed"]);
    assert.equal(body.plugin_id, "external-agent");
    assert.equal(body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(body.records), /DENIED SEARCH/);

    assert.equal(queryParamResponse.status, 200);
    assert.equal(queryParamBody.ok, true);
    assert.deepEqual(queryParamBody.records.map(record => record.id), ["record:http-search-plugin-allowed"]);
    assert.equal(queryParamBody.plugin_id, "external-agent");
    assert.equal(queryParamBody.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(queryParamBody.records), /DENIED SEARCH/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("POST /context/search with unknown plugin_id does not fall back to unscoped Observations", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-search-unknown-plugin",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden source", text: "unknown search token SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/search?plugin_id=missing-plugin", {
    method: "POST",
    body: { query: "unknown search token", limit: 10 },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /SHOULD NOT LEAK/);
}));
test("POST /context/search with plugin_id does not let hidden records starve visible search results", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-search-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "search-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "search-reader", "plugin.json"), JSON.stringify({
      id: "search-reader",
      name: "Search Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-search-starvation-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Visible source", text: "shared starvation token visible context" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertRecord({
        id: `record:http-search-starvation-hidden-${index}`,
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser" },
        content: { title: "Hidden source", text: `shared starvation token HIDDEN SEARCH CONTEXT ${index}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
    }

    const response = await request(store, "/context/search?plugin_id=search-reader", {
      method: "POST",
      body: { query: "shared starvation token", limit: 5 },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.records.map((record: { id: string }) => record.id), ["record:http-search-starvation-visible"]);
    assert.doesNotMatch(JSON.stringify(response.body.records), /HIDDEN SEARCH/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /context/records/:id returns a single Observation for Applications", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-single-record",
    schema: { name: "observation.git.diff", version: 1 },
    source: { type: "git", connector: "local" },
    content: { title: "HTTP single record", text: "diff --git" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/records/${encodeURIComponent("record:http-single-record")}`);
  const body = response.body as { ok: boolean; record: { id: string; schema: { name: string }; source: { type: string } } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.record.id, "record:http-single-record");
  assert.equal(body.record.schema.name, "observation.git.diff");
  assert.equal(body.record.source.type, "git");
}));

test("GET /context/records/:id with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-record-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-record-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied source", text: "DENIED RECORD CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const denied = await request(store, `/context/records/${encodeURIComponent("record:http-record-plugin-denied")}?plugin_id=external-agent`);
    const unscoped = await request(store, `/context/records/${encodeURIComponent("record:http-record-plugin-denied")}`);

    assert.equal(denied.status, 404);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.error, "record not found");
    assert.equal(denied.body.plugin_id, "external-agent");
    assert.equal(denied.body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(denied.body), /DENIED RECORD/);

    assert.equal(unscoped.status, 200);
    assert.match(JSON.stringify(unscoped.body), /DENIED RECORD CONTEXT SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("GET /context/records/:id with unknown plugin_id does not fall back to unscoped Observation", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-record-unknown-plugin",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden source", text: "UNKNOWN RECORD PLUGIN SHOULD NOT SEE THIS RECORD" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/records/${encodeURIComponent("record:http-record-unknown-plugin")}?plugin_id=missing-plugin`);

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN RECORD PLUGIN SHOULD NOT SEE/);
}));
test("GET /context/records/:id returns 404 for missing Observation", async () => withStore(async (store) => {
  const response = await request(store, `/context/records/${encodeURIComponent("missing:record")}`);
  const body = response.body as { ok: boolean; error: string };

  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, "record not found");
}));

test("POST and GET /context/connectors expose runtime connector registry", async () => withStore(async (store) => {
  const create = await request(store, "/context/connectors", {
    method: "POST",
    body: {
      id: "browser-extension",
      name: "Browser Extension",
      type: "ambient",
      version: 1,
      description: "Captures browser observations and explicit ambient requests.",
      schemas_produced: [
        { name: "observation.browser_page_snapshot", version: 1 },
        { name: "observation.browser_ambient_requested", version: 1 },
      ],
      default_scope: { app: "chrome" },
      default_privacy: {
        level: "private",
        retention: "normal",
        allow_external_llm: false,
        allow_external_reader: false,
      },
      permissions: {
        allow_network: false,
        allow_external_llm: false,
        allow_external_reader: false,
        max_privacy_level: "private",
      },
      config: { source: "extension" },
    },
  });
  const list = await request(store, "/context/connectors");
  const connector = list.body.connectors.find((item: { id: string }) => item.id === "browser-extension");

  assert.equal(create.status, 201);
  assert.equal(create.body.ok, true);
  assert.equal(create.body.connector.id, "browser-extension");
  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  assert.ok(connector);
  assert.deepEqual(connector.schemas_produced.map((schema: { name: string }) => schema.name), [
    "observation.browser_page_snapshot",
    "observation.browser_ambient_requested",
  ]);
  assert.equal(connector.default_scope.app, "chrome");
  assert.equal(connector.default_privacy.allow_external_llm, false);
  assert.equal(connector.permissions.allow_external_reader, false);
}));

test("Registry endpoints reject plugin callers", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-registry-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "registry-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "registry-client", "plugin.json"), JSON.stringify({
      id: "registry-client",
      name: "Registry Client",
      permissions: {
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const postConnector = await request(store, "/context/connectors?plugin_id=registry-client", {
      method: "POST",
      body: {
        id: "plugin-owned-connector",
        name: "Plugin-owned connector",
        type: "ambient",
      },
    });
    const getConnectors = await request(store, "/context/connectors?plugin_id=registry-client");
    const postSchema = await request(store, "/context/schemas", {
      method: "POST",
      body: {
        plugin_id: "registry-client",
        name: "observation.plugin_owned",
        version: 1,
      },
    });
    const getSchemas = await request(store, "/context/schemas?plugin_id=registry-client");

    for (const response of [postConnector, getConnectors, postSchema, getSchemas]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.error, "plugins cannot access raw context registry");
      assert.equal(response.body.plugin_id, "registry-client");
      assert.equal(response.body.plugin_loaded, true);
    }
    assert.equal(store.getConnector("plugin-owned-connector"), undefined);
    assert.equal(store.listSchemas({ name: "observation.plugin_owned" }).length, 0);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Plugin run endpoints reject plugin callers", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-plugin-run-policy-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "runner-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "runner-client", "plugin.json"), JSON.stringify({
      id: "runner-client",
      name: "Runner Client",
      permissions: {
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const queryParam = await request(store, "/plugins/language-learning/run?plugin_id=runner-client", {
      method: "POST",
      body: { write: false },
    });
    const bodyParam = await request(store, "/plugins/language-learning/run", {
      method: "POST",
      body: { plugin_id: "runner-client", write: false },
    });

    for (const response of [queryParam, bodyParam]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.error, "plugins cannot run plugin entrypoints directly");
      assert.equal(response.body.plugin_id, "runner-client");
      assert.equal(response.body.plugin_loaded, true);
    }
    assert.equal(store.listRuntimeEvents({ event_type: "plugin_run_started", plugin_id: "language-learning", limit: 1 }).length, 0);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/ingest applies registered connector default scope and privacy", async () => withStore(async (store) => {
  await request(store, "/context/connectors", {
    method: "POST",
    body: {
      id: "screenpipe-test-connector",
      name: "Screenpipe Test Connector",
      type: "ambient",
      default_scope: { app: "Screenpipe", user: "local-user" },
      default_privacy: { level: "private", allow_external_llm: false, retention: "normal" },
    },
  });

  const response = await request(store, "/context/ingest", {
    method: "POST",
    body: {
      id: "record:http-connector-defaults",
      schema: { name: "observation.screen.ocr", version: 1 },
      source: { type: "screenpipe", connector: "screenpipe-test-connector" },
      content: { text: "Observed screen text" },
      scope: { domain: "example.com" },
      privacy: { allow_embedding: true },
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.record.scope.app, "Screenpipe");
  assert.equal(response.body.record.scope.user, "local-user");
  assert.equal(response.body.record.scope.domain, "example.com");
  assert.equal(response.body.record.privacy.level, "private");
  assert.equal(response.body.record.privacy.allow_external_llm, false);
  assert.equal(response.body.record.privacy.allow_embedding, true);
}));

test("POST /context/ingest honors connector default retention before storing", async () => withStore(async (store) => {
  await request(store, "/context/connectors", {
    method: "POST",
    body: {
      id: "secret-test-connector",
      name: "Secret Test Connector",
      type: "explicit",
      default_privacy: { level: "secret", retention: "do_not_store" },
    },
  });

  const response = await request(store, "/context/ingest", {
    method: "POST",
    body: {
      id: "record:http-connector-do-not-store",
      schema: { name: "observation.secret", version: 1 },
      source: { type: "manual", connector: "secret-test-connector" },
      content: { text: "Do not persist this" },
    },
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.stored, false);
  assert.equal(store.getRecord("record:http-connector-do-not-store"), undefined);
}));

test("POST /context/ingest treats chrome-extension browser scope as observed page scope only", async () => withStore(async (store) => {
  const response = await request(store, "/context/ingest", {
    method: "POST",
    body: {
      id: "record:http-browser-scope-sanitize",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: {
        app: "chrome",
        domain: "github.com",
        project: "info",
        project_path: "/Users/junjie/info",
        repo: "example/repo",
      },
      content: {
        title: "Browser page",
        url: "https://github.com/example/repo",
        text: "Browser sensors should not claim project membership.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.record.scope.domain, "github.com");
  assert.equal(response.body.record.scope.app, "chrome");
  assert.equal(response.body.record.scope.project, undefined);
  assert.equal(response.body.record.scope.project_path, undefined);
  assert.equal(response.body.record.scope.repo, undefined);
}));

test("POST /context/ingest rejects non-observation and non-feedback Records at the raw boundary", async () => withStore(async (store) => {
  const derived = await request(store, "/context/ingest", {
    method: "POST",
    body: {
      id: "record:http-ingest-derived-legacy",
      schema: { name: "derived.project_memory", version: 1 },
      source: { type: "plugin", connector: "legacy-derived" },
      content: { title: "Legacy derived memory", text: "Inferred state should be a View, not a Record." },
    },
  });
  const episode = await request(store, "/context/ingest", {
    method: "POST",
    body: {
      id: "record:http-ingest-episode-legacy",
      schema: { name: "episode.project_work", version: 1 },
      source: { type: "plugin", connector: "legacy-episode" },
      content: { title: "Legacy episode", text: "Episode summaries should be Views." },
    },
  });
  const analysis = await request(store, "/context/ingest", {
    method: "POST",
    body: {
      id: "record:http-ingest-analysis-as-record",
      schema: { name: "analysis.browser_page", version: 1 },
      source: { type: "plugin", connector: "legacy-analysis" },
      content: { title: "Analysis as record", text: "Analysis should be written through /context/views." },
    },
  });

  assert.equal(derived.status, 400);
  assert.equal(derived.body.ok, false);
  assert.match(String(derived.body.error), /observation.*feedback.*View/i);
  assert.equal(episode.status, 400);
  assert.equal(episode.body.ok, false);
  assert.match(String(episode.body.error), /observation.*feedback.*View/i);
  assert.equal(analysis.status, 400);
  assert.equal(analysis.body.ok, false);
  assert.match(String(analysis.body.error), /observation.*feedback.*View/i);
  assert.equal(store.getRecord("record:http-ingest-derived-legacy"), undefined);
  assert.equal(store.getRecord("record:http-ingest-episode-legacy"), undefined);
  assert.equal(store.getRecord("record:http-ingest-analysis-as-record"), undefined);
  assert.equal(store.listRuntimeEvents({ event_type: "record_ingested", limit: 10 }).length, 0);
}));

test("POST /context/ingest with plugin_id applies record write permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-ingest-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "browser-ingester"), { recursive: true });
    writeFileSync(join(dir, "plugins", "browser-ingester", "plugin.json"), JSON.stringify({
      id: "browser-ingester",
      name: "Browser Ingester",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const deniedBySchema = await request(store, "/context/ingest?plugin_id=browser-ingester", {
      method: "POST",
      body: {
        id: "record:http-plugin-ingest-denied-schema",
        schema: { name: "observation.git.diff", version: 1 },
        source: { type: "browser" },
        content: { text: "wrong schema" },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      },
    });
    const deniedBySource = await request(store, "/context/ingest?plugin_id=browser-ingester", {
      method: "POST",
      body: {
        id: "record:http-plugin-ingest-denied-source",
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "git" },
        content: { text: "wrong source" },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      },
    });
    const deniedByPrivacy = await request(store, "/context/ingest?plugin_id=browser-ingester", {
      method: "POST",
      body: {
        id: "record:http-plugin-ingest-denied-privacy",
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser" },
        content: { text: "external LLM denied" },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      },
    });
    const deniedByBodyPlugin = await request(store, "/context/ingest", {
      method: "POST",
      body: {
        id: "record:http-plugin-ingest-denied-body-plugin",
        schema: { name: "observation.git.diff", version: 1 },
        source: { type: "browser" },
        scope: { plugin_id: "browser-ingester" },
        content: { text: "wrong schema via body plugin" },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      },
    });
    const allowed = await request(store, "/context/ingest?plugin_id=browser-ingester", {
      method: "POST",
      body: {
        id: "record:http-plugin-ingest-allowed",
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser" },
        content: { text: "allowed browser request" },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      },
    });

    assert.equal(deniedBySchema.status, 403);
    assert.equal(deniedBySchema.body.error, "plugin cannot write this record");
    assert.equal(deniedBySource.status, 403);
    assert.equal(deniedByPrivacy.status, 403);
    assert.equal(deniedByBodyPlugin.status, 403);
    assert.equal(deniedByBodyPlugin.body.error, "plugin cannot write this record");
    assert.equal(store.getRecord("record:http-plugin-ingest-denied-schema"), undefined);
    assert.equal(store.getRecord("record:http-plugin-ingest-denied-source"), undefined);
    assert.equal(store.getRecord("record:http-plugin-ingest-denied-privacy"), undefined);
    assert.equal(store.getRecord("record:http-plugin-ingest-denied-body-plugin"), undefined);

    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.ok, true);
    assert.equal(allowed.body.plugin_id, "browser-ingester");
    assert.equal(allowed.body.plugin_loaded, true);
    assert.equal(allowed.body.record.scope.plugin_id, "browser-ingester");
    assert.equal(store.getRecord("record:http-plugin-ingest-allowed")?.scope?.plugin_id, "browser-ingester");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/schemas registers source schemas at runtime", async () => withStore(async (store) => {
  const response = await request(store, "/context/schemas", {
    method: "POST",
    body: {
      name: "observation.browser_ambient_requested",
      version: 1,
      description: "Explicit browser ambient exploration request from an Application.",
      json_schema: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "object",
            required: ["url"],
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              text: { type: "string" },
            },
          },
        },
      },
      example: {
        content: {
          title: "example/repo",
          url: "https://github.com/example/repo",
          text: "Repository README",
        },
      },
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.schema.name, "observation.browser_ambient_requested");
  assert.equal(response.body.schema.version, 1);
  assert.equal(response.body.schema.json_schema.properties.content.required[0], "url");
  assert.equal(response.body.schema.example.content.url, "https://github.com/example/repo");
}));

test("GET /context/schemas exposes registered schema registry entries", async () => withStore(async (store) => {
  store.registerSchema({
    name: "observation.browser_ambient_requested",
    version: 1,
    description: "Explicit browser ambient request.",
    json_schema: { type: "object", required: ["content"] },
    example: { content: { url: "https://example.com" } },
  });
  store.registerSchema({
    name: "analysis.browser_page",
    version: 1,
    description: "Browser page analysis View.",
  });

  const list = await request(store, "/context/schemas");
  const filtered = await request(store, "/context/schemas?name=observation.browser_ambient_requested&version=1");

  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  assert.deepEqual(list.body.schemas.map((schema: { name: string }) => schema.name), [
    "analysis.browser_page",
    "observation.browser_ambient_requested",
  ]);

  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.ok, true);
  assert.equal(filtered.body.schemas.length, 1);
  assert.equal(filtered.body.schemas[0].name, "observation.browser_ambient_requested");
  assert.equal(filtered.body.schemas[0].version, 1);
  assert.equal(filtered.body.schemas[0].json_schema.required[0], "content");
  assert.equal(filtered.body.schemas[0].example.content.url, "https://example.com");
}));

test("POST /context/artifacts stores large artifact references separately from Observations", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-artifact-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: {
      title: "Captured PDF page",
      url: "https://example.com/agent-runtime-paper.pdf",
      text: "Short textual metadata; raw PDF stays as artifact reference.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/context/artifacts", {
    method: "POST",
    body: {
      id: "artifact:http-pdf",
      record_id: "record:http-artifact-source",
      kind: "pdf",
      mime_type: "application/pdf",
      uri: "file:///tmp/agent-runtime-paper.pdf",
      sha256: "abc123",
      size_bytes: 12345,
      metadata: {
        raw_media_stays_local: true,
        captured_by: "browser-extension",
      },
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.id, "artifact:http-pdf");
  assert.equal(response.body.artifact.record_id, "record:http-artifact-source");
  assert.equal(response.body.artifact.kind, "pdf");
  assert.equal(response.body.artifact.uri, "file:///tmp/agent-runtime-paper.pdf");
  assert.equal(response.body.artifact.metadata.raw_media_stays_local, true);
}));

test("POST /context/artifacts with plugin_id applies source record permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-artifact-write-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-artifact-write-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed artifact write source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-artifact-write-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied artifact write source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const denied = await request(store, "/context/artifacts?plugin_id=external-agent", {
      method: "POST",
      body: {
        id: "artifact:http-plugin-write-denied",
        record_id: "record:http-artifact-write-denied",
        kind: "pdf",
        uri: "file:///tmp/DENIED-ARTIFACT-WRITE-SHOULD-NOT-PERSIST.pdf",
      },
    });
    const allowed = await request(store, "/context/artifacts?plugin_id=external-agent", {
      method: "POST",
      body: {
        id: "artifact:http-plugin-write-allowed",
        record_id: "record:http-artifact-write-allowed",
        kind: "pdf",
        uri: "file:///tmp/allowed-write.pdf",
      },
    });

    assert.equal(denied.status, 403);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.error, "plugin cannot write artifact for this record");
    assert.equal(denied.body.plugin_id, "external-agent");
    assert.equal(denied.body.plugin_loaded, true);
    assert.equal(store.getArtifact("artifact:http-plugin-write-denied"), undefined);

    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.ok, true);
    assert.equal(allowed.body.artifact.id, "artifact:http-plugin-write-allowed");
    assert.equal(allowed.body.plugin_id, "external-agent");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /context/artifacts returns artifact references for a source record", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-artifact-list-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "PDF", url: "https://example.com/paper.pdf" },
  });
  store.insertArtifact({
    id: "artifact:http-pdf-list",
    record_id: "record:http-artifact-list-source",
    kind: "pdf",
    uri: "file:///tmp/paper.pdf",
    metadata: { raw_media_stays_local: true },
  });

  const response = await request(store, "/context/artifacts?record_id=record%3Ahttp-artifact-list-source");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.artifacts.length, 1);
  assert.equal(response.body.artifacts[0].id, "artifact:http-pdf-list");
  assert.equal(response.body.artifacts[0].record_id, "record:http-artifact-list-source");
  assert.equal(response.body.artifacts[0].metadata.raw_media_stays_local, true);
}));

test("GET /context/artifacts hides artifacts for legacy non-observation Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-artifact-legacy-source",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy derived source", text: "Legacy artifact source should not be exposed." },
  });
  store.insertRecord({
    id: "record:http-artifact-visible-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Visible artifact source" },
  });
  store.insertArtifact({
    id: "artifact:http-legacy-hidden",
    record_id: "record:http-artifact-legacy-source",
    kind: "pdf",
    uri: "file:///tmp/LEGACY-ARTIFACT-SHOULD-NOT-LEAK.pdf",
  });
  store.insertArtifact({
    id: "artifact:http-visible",
    record_id: "record:http-artifact-visible-source",
    kind: "pdf",
    uri: "file:///tmp/visible.pdf",
  });

  const list = await request(store, "/context/artifacts?limit=10");
  const scoped = await request(store, "/context/artifacts?record_id=record%3Ahttp-artifact-legacy-source");
  const single = await request(store, "/context/artifacts/artifact%3Ahttp-legacy-hidden");

  assert.equal(list.status, 200);
  assert.deepEqual(list.body.artifacts.map((artifact: { id: string }) => artifact.id), ["artifact:http-visible"]);
  assert.doesNotMatch(JSON.stringify(list.body), /LEGACY-ARTIFACT-SHOULD-NOT-LEAK/);
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.artifacts, []);
  assert.equal(single.status, 404);
  assert.equal(single.body.ok, false);
  assert.doesNotMatch(JSON.stringify(single.body), /LEGACY-ARTIFACT-SHOULD-NOT-LEAK/);
}));

test("GET /context/artifacts with plugin_id applies source record permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-artifacts-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-artifact-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed artifact source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-artifact-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied artifact source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertArtifact({
      id: "artifact:http-plugin-allowed",
      record_id: "record:http-artifact-plugin-allowed",
      kind: "pdf",
      uri: "file:///tmp/allowed.pdf",
    });
    store.insertArtifact({
      id: "artifact:http-plugin-denied",
      record_id: "record:http-artifact-plugin-denied",
      kind: "pdf",
      uri: "file:///tmp/DENIED-ARTIFACT-SHOULD-NOT-LEAK.pdf",
    });

    const response = await request(store, "/context/artifacts?plugin_id=external-agent&limit=10");
    const body = response.body as { ok: boolean; artifacts: Array<{ id: string }>; plugin_id?: string; plugin_loaded?: boolean };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.artifacts.map(artifact => artifact.id), ["artifact:http-plugin-allowed"]);
    assert.equal(body.plugin_id, "external-agent");
    assert.equal(body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(body.artifacts), /DENIED-ARTIFACT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /context/artifacts with plugin_id does not let hidden artifacts starve visible artifacts", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-artifacts-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "artifact-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "artifact-reader", "plugin.json"), JSON.stringify({
      id: "artifact-reader",
      name: "Artifact Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-artifact-starvation-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Visible artifact source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-artifact-starvation-hidden",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Hidden artifact source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertArtifact({
      id: "artifact:http-starvation-visible",
      record_id: "record:http-artifact-starvation-visible",
      kind: "pdf",
      uri: "file:///tmp/visible.pdf",
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertArtifact({
        id: `artifact:http-starvation-hidden-${index}`,
        record_id: "record:http-artifact-starvation-hidden",
        kind: "pdf",
        uri: `file:///tmp/HIDDEN-ARTIFACT-${index}.pdf`,
      });
    }

    const response = await request(store, "/context/artifacts?plugin_id=artifact-reader&limit=5");

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.artifacts.map((artifact: { id: string }) => artifact.id), ["artifact:http-starvation-visible"]);
    assert.doesNotMatch(JSON.stringify(response.body.artifacts), /HIDDEN-ARTIFACT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /context/artifacts/:id returns one artifact reference", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-artifact-get-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "PDF", url: "https://example.com/get-paper.pdf" },
  });
  store.insertArtifact({
    id: "artifact:http-pdf-get",
    record_id: "record:http-artifact-get-source",
    kind: "pdf",
    mime_type: "application/pdf",
    uri: "file:///tmp/get-paper.pdf",
    size_bytes: 42,
  });

  const response = await request(store, "/context/artifacts/artifact%3Ahttp-pdf-get");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.artifact.id, "artifact:http-pdf-get");
  assert.equal(response.body.artifact.mime_type, "application/pdf");
  assert.equal(response.body.artifact.size_bytes, 42);
}));

test("GET /context/artifacts/:id with plugin_id applies source record permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-artifact-get-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-artifact-get-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied artifact source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertArtifact({
      id: "artifact:http-plugin-get-denied",
      record_id: "record:http-artifact-get-plugin-denied",
      kind: "pdf",
      uri: "file:///tmp/DENIED-ARTIFACT-GET-SHOULD-NOT-LEAK.pdf",
    });

    const denied = await request(store, "/context/artifacts/artifact%3Ahttp-plugin-get-denied?plugin_id=external-agent");
    const unscoped = await request(store, "/context/artifacts/artifact%3Ahttp-plugin-get-denied");

    assert.equal(denied.status, 404);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.error, "artifact not found");
    assert.equal(denied.body.plugin_id, "external-agent");
    assert.equal(denied.body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(denied.body), /DENIED-ARTIFACT/);

    assert.equal(unscoped.status, 200);
    assert.match(JSON.stringify(unscoped.body), /DENIED-ARTIFACT-GET-SHOULD-NOT-LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST and GET /runtime/events expose provenance event log filters", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-runtime-event",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Runtime event source" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-runtime-event",
    view_type: "analysis.browser_page",
    source_records: ["record:http-runtime-event"],
    content: { analysis: "runtime event view" },
    privacy: { level: "private", retention: "normal" },
  });

  const created = await request(store, "/runtime/events", {
    method: "POST",
    body: {
      event_type: "test.provenance_event",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: "analysis:http-runtime-event",
      plugin_id: "program.browser_ambient",
      related_records: ["record:http-runtime-event"],
      related_views: ["analysis:http-runtime-event"],
      payload: { reason: "test event provenance" },
    },
  });
  store.appendRuntimeEvent({
    event_type: "test.other_event",
    actor: "system",
    status: "completed",
    subject_type: "record",
    subject_id: "record:other",
    plugin_id: "program.other",
  });

  const listed = await request(store, "/runtime/events?type=test.provenance_event&plugin=program.browser_ambient&subject_type=view&subject_id=analysis%3Ahttp-runtime-event");

  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.event.event_type, "test.provenance_event");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.deepEqual(listed.body.events.map((event: { id: string }) => event.id), [created.body.event.id]);
  assert.equal(listed.body.events[0].plugin_id, "program.browser_ambient");
  assert.deepEqual(listed.body.events[0].related_records, ["record:http-runtime-event"]);
  assert.deepEqual(listed.body.events[0].related_views, ["analysis:http-runtime-event"]);
  assert.equal(listed.body.events[0].payload.reason, "test event provenance");
}));

test("HTTP runtime events hide and reject legacy non-observation related Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-runtime-event-legacy",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy event source", text: "LEGACY RUNTIME EVENT SOURCE SHOULD NOT LEAK" },
  });
  const hidden = store.appendRuntimeEvent({
    event_type: "program.run.completed",
    actor: "system",
    status: "completed",
    related_records: ["record:http-runtime-event-legacy"],
    payload: { reason: "LEGACY RELATED RECORD EVENT SHOULD NOT LEAK" },
  });
  const visible = store.appendRuntimeEvent({
    event_type: "program.run.completed",
    actor: "system",
    status: "completed",
    payload: { reason: "visible event" },
  });

  const list = await request(store, "/runtime/events?type=program.run.completed&limit=10");
  const rejected = await request(store, "/runtime/events", {
    method: "POST",
    body: {
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      related_records: ["record:http-runtime-event-legacy"],
      payload: { reason: "LEGACY RELATED RECORD WRITE SHOULD NOT PERSIST" },
    },
  });

  assert.equal(list.status, 200);
  assert.deepEqual(list.body.events.map((event: { id: string }) => event.id), [visible.id]);
  assert.ok(!list.body.events.some((event: { id: string }) => event.id === hidden.id));
  assert.doesNotMatch(JSON.stringify(list.body), /LEGACY RUNTIME EVENT SOURCE SHOULD NOT LEAK/);
  assert.doesNotMatch(JSON.stringify(list.body), /LEGACY RELATED RECORD EVENT SHOULD NOT LEAK/);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.ok, false);
  assert.equal(rejected.body.error, "event cannot reference this record");
  assert.equal(store.listRuntimeEvents({ event_type: "program.run.completed", limit: 10 }).length, 2);
}));



test("GET /runtime/events hides events with missing related context", async () => withStore(async (store) => {
  store.appendRuntimeEvent({
    event_type: "program.run.completed",
    actor: "system",
    status: "completed",
    related_records: ["record:http-runtime-event-missing-record"],
    payload: { reason: "MISSING RELATED RECORD EVENT SHOULD NOT LEAK" },
  });
  store.appendRuntimeEvent({
    event_type: "program.run.completed",
    actor: "system",
    status: "completed",
    related_views: ["analysis:http-runtime-event-missing-view-read"],
    payload: { reason: "MISSING RELATED VIEW EVENT SHOULD NOT LEAK" },
  });
  const visible = store.appendRuntimeEvent({
    event_type: "program.run.completed",
    actor: "system",
    status: "completed",
    payload: { reason: "visible runtime event" },
  });

  const response = await request(store, "/runtime/events?type=program.run.completed&limit=10");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.events.map((event: { id: string }) => event.id), [visible.id]);
  assert.doesNotMatch(JSON.stringify(response.body), /MISSING RELATED/);
}));

test("POST /runtime/events rejects missing related Records", async () => withStore(async (store) => {
  const response = await request(store, "/runtime/events", {
    method: "POST",
    body: {
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      related_records: ["record:http-runtime-event-missing-record-write"],
      payload: { reason: "MISSING RELATED RECORD WRITE SHOULD NOT PERSIST" },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "event cannot reference this record");
  assert.equal(store.listRuntimeEvents({ event_type: "program.run.completed", limit: 10 }).length, 0);
}));

test("POST /runtime/events rejects missing related Views", async () => withStore(async (store) => {
  const response = await request(store, "/runtime/events", {
    method: "POST",
    body: {
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      related_views: ["analysis:http-runtime-event-missing-view"],
      payload: { reason: "MISSING RELATED VIEW EVENT SHOULD NOT PERSIST" },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "event cannot reference this view");
  assert.equal(store.listRuntimeEvents({ event_type: "program.run.completed", limit: 10 }).length, 0);
}));

test("POST /runtime/events rejects related Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-runtime-event-dirty-view-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Dirty event source", text: "DIRTY EVENT SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-runtime-event-dirty-view",
    view_type: "analysis.github_issue",
    title: "Dirty event View",
    source_records: ["record:http-runtime-event-dirty-view-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "DIRTY EVENT VIEW SHOULD NOT BECOME PROVENANCE" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/runtime/events", {
    method: "POST",
    body: {
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      related_views: ["analysis:http-runtime-event-dirty-view"],
      payload: { reason: "DIRTY RELATED VIEW EVENT SHOULD NOT PERSIST" },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "event cannot reference this view");
  assert.doesNotMatch(JSON.stringify(response.body), /DIRTY EVENT/);
  assert.equal(store.listRuntimeEvents({ event_type: "program.run.completed", limit: 10 }).length, 0);
}));

test("GET /runtime/events with plugin_id applies event and related context permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-runtime-events-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        allowed_event_types: ["program.run.completed"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-runtime-event-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed event source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-runtime-event-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied event source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const allowed = store.appendRuntimeEvent({
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      subject_type: "plugin",
      subject_id: "external-agent",
      plugin_id: "external-agent",
      related_records: ["record:http-runtime-event-allowed"],
      payload: { reason: "ALLOWED RUNTIME EVENT" },
    });
    store.appendRuntimeEvent({
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      subject_type: "plugin",
      subject_id: "external-agent",
      plugin_id: "external-agent",
      related_records: ["record:http-runtime-event-denied"],
      payload: { reason: "DENIED RELATED RECORD EVENT SHOULD NOT LEAK" },
    });
    store.appendRuntimeEvent({
      event_type: "policy.denied_action",
      actor: "system",
      status: "denied",
      subject_type: "plugin",
      subject_id: "external-agent",
      plugin_id: "external-agent",
      payload: { reason: "DENIED EVENT TYPE SHOULD NOT LEAK" },
    });

    const response = await request(store, "/runtime/events?plugin_id=external-agent&limit=10");
    const body = response.body as { ok: boolean; events: Array<{ id: string }>; plugin_id?: string; plugin_loaded?: boolean };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.events.map(event => event.id), [allowed.id]);
    assert.equal(body.plugin_id, "external-agent");
    assert.equal(body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(body.events), /DENIED/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /runtime/events with plugin_id does not let hidden events starve visible provenance events", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-runtime-events-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "event-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "event-reader", "plugin.json"), JSON.stringify({
      id: "event-reader",
      name: "Event Reader",
      permissions: {
        allowed_event_types: ["program.run.completed"],
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const visible = store.appendRuntimeEvent({
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      payload: { reason: "VISIBLE PROVENANCE EVENT" },
    });
    for (let index = 0; index < 25; index++) {
      store.appendRuntimeEvent({
        event_type: "policy.denied_action",
        actor: "system",
        status: "denied",
        payload: { reason: `HIDDEN EVENT ${index}` },
      });
    }

    const response = await request(store, "/runtime/events?plugin_id=event-reader&limit=5");

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.events.map((event: { id: string }) => event.id), [visible.id]);
    assert.doesNotMatch(JSON.stringify(response.body.events), /HIDDEN EVENT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("GET /runtime/events with unknown plugin_id does not fall back to unscoped events", async () => withStore(async (store) => {
  store.appendRuntimeEvent({
    event_type: "agent_task.completed",
    actor: "agent",
    status: "completed",
    subject_type: "view",
    subject_id: "analysis:http-runtime-event-unknown-plugin",
    payload: { summary: "UNKNOWN EVENT PLUGIN SHOULD NOT SEE THIS EVENT" },
  });

  const response = await request(store, "/runtime/events?plugin_id=missing-plugin&limit=10");

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN EVENT PLUGIN SHOULD NOT SEE/);
}));
test("POST /runtime/events with plugin_id requires allowed event type and related context permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-runtime-event-write-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "event-writer"), { recursive: true });
    writeFileSync(join(dir, "plugins", "event-writer", "plugin.json"), JSON.stringify({
      id: "event-writer",
      name: "Event Writer",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_event_types: ["program.run.completed"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-runtime-event-write-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed event write source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-runtime-event-write-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied event write source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertRecord({
      id: "record:http-runtime-event-write-denied-view-source",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git" },
      content: { title: "Denied event View source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-runtime-event-write-denied-view",
      view_type: "analysis.browser_page",
      source_records: ["record:http-runtime-event-write-denied-view-source"],
      content: { analysis: "DENIED EVENT RELATED VIEW SHOULD NOT BECOME PROVENANCE" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const deniedByType = await request(store, "/runtime/events?plugin_id=event-writer", {
      method: "POST",
      body: {
        event_type: "policy.denied_action",
        actor: "plugin",
        status: "denied",
        payload: { reason: "DENIED EVENT TYPE WRITE SHOULD NOT PERSIST" },
      },
    });
    const deniedByRecord = await request(store, "/runtime/events?plugin_id=event-writer", {
      method: "POST",
      body: {
        event_type: "program.run.completed",
        actor: "plugin",
        status: "completed",
        related_records: ["record:http-runtime-event-write-denied"],
        payload: { reason: "DENIED RELATED RECORD WRITE SHOULD NOT PERSIST" },
      },
    });
    const deniedByBodyPlugin = await request(store, "/runtime/events", {
      method: "POST",
      body: {
        plugin_id: "event-writer",
        event_type: "policy.denied_action",
        actor: "plugin",
        status: "denied",
        payload: { reason: "BODY PLUGIN DENIED EVENT TYPE SHOULD NOT PERSIST" },
      },
    });
    const deniedByViewProvenance = await request(store, "/runtime/events?plugin_id=event-writer", {
      method: "POST",
      body: {
        event_type: "program.run.completed",
        actor: "plugin",
        status: "completed",
        related_views: ["analysis:http-runtime-event-write-denied-view"],
        payload: { reason: "DENIED RELATED VIEW WRITE SHOULD NOT PERSIST" },
      },
    });
    const deniedByMissingContext = await request(store, "/runtime/events?plugin_id=event-writer", {
      method: "POST",
      body: {
        event_type: "program.run.completed",
        actor: "plugin",
        status: "completed",
        related_records: ["record:http-runtime-event-write-missing"],
        related_views: ["analysis:http-runtime-event-write-missing"],
        payload: { reason: "MISSING RELATED CONTEXT SHOULD NOT PERSIST" },
      },
    });
    const allowed = await request(store, "/runtime/events?plugin_id=event-writer", {
      method: "POST",
      body: {
        event_type: "program.run.completed",
        actor: "plugin",
        status: "completed",
        related_records: ["record:http-runtime-event-write-allowed"],
        payload: { reason: "allowed runtime event write" },
      },
    });

    assert.equal(deniedByType.status, 403);
    assert.equal(deniedByType.body.ok, false);
    assert.equal(deniedByType.body.error, "plugin cannot write this event_type");
    assert.equal(deniedByRecord.status, 403);
    assert.equal(deniedByRecord.body.ok, false);
    assert.equal(deniedByRecord.body.error, "plugin cannot reference this event context");
    assert.equal(deniedByBodyPlugin.status, 403);
    assert.equal(deniedByBodyPlugin.body.ok, false);
    assert.equal(deniedByBodyPlugin.body.error, "plugin cannot write this event_type");
    assert.equal(deniedByViewProvenance.status, 403);
    assert.equal(deniedByViewProvenance.body.ok, false);
    assert.equal(deniedByViewProvenance.body.error, "plugin cannot reference this event context");
    assert.equal(deniedByMissingContext.status, 403);
    assert.equal(deniedByMissingContext.body.ok, false);
    assert.equal(deniedByMissingContext.body.error, "plugin cannot reference this event context");
    assert.equal(store.listRuntimeEvents({ event_type: "program.run.completed", plugin_id: "event-writer", limit: 10 }).length, 1);

    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.ok, true);
    assert.equal(allowed.body.event.plugin_id, "event-writer");
    assert.equal(allowed.body.event.event_type, "program.run.completed");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /runtime/tick rejects plugin callers", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-runtime-tick-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "runtime-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "runtime-client", "plugin.json"), JSON.stringify({
      id: "runtime-client",
      name: "Runtime Client",
      permissions: {
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const response = await request(store, "/runtime/tick?plugin_id=runtime-client", {
      method: "POST",
      body: {
        include_screenpipe: false,
        include_ai_sessions: false,
        include_git: false,
        write: false,
      },
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, "plugins cannot run runtime tick");
    assert.equal(response.body.plugin_id, "runtime-client");
    assert.equal(response.body.plugin_loaded, true);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /runtime/status rejects plugin callers", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-runtime-status-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "runtime-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "runtime-client", "plugin.json"), JSON.stringify({
      id: "runtime-client",
      name: "Runtime Client",
      permissions: {
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const response = await request(store, "/runtime/status?plugin_id=runtime-client");

    assert.equal(response.status, 403);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, "plugins cannot read raw runtime status");
    assert.equal(response.body.plugin_id, "runtime-client");
    assert.equal(response.body.plugin_loaded, true);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Thread operations reject plugin callers", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-thread-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "thread-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "thread-client", "plugin.json"), JSON.stringify({
      id: "thread-client",
      name: "Thread Client",
      permissions: {
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const interpret = await request(store, "/thread/interpret?plugin_id=thread-client", {
      method: "POST",
      body: { thread_id: "active", write: false },
    });
    const evidence = await request(store, "/thread/evidence?plugin_id=thread-client&thread_id=active");
    const merge = await request(store, "/thread/merge", {
      method: "POST",
      body: { plugin_id: "thread-client", target_id: "a", source_ids: ["b"], write: false },
    });
    const split = await request(store, "/thread/split?plugin_id=thread-client", {
      method: "POST",
      body: { thread_id: "a", evidence_ids: ["record:a"], write: false },
    });

    for (const response of [interpret, evidence, merge, split]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.error, "plugins cannot operate on WorkThreads");
      assert.equal(response.body.plugin_id, "thread-client");
      assert.equal(response.body.plugin_loaded, true);
    }
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/query includes runtime events only when explicitly requested", async () => withStore(async (store) => {
  const event = store.appendRuntimeEvent({
    event_type: "test.context_query_event",
    actor: "system",
    status: "completed",
    subject_type: "runtime",
    subject_id: "context-query-test",
    plugin_id: "program.browser_ambient",
    payload: { reason: "broker event provenance" },
  });

  const defaultQuery = await request(store, "/context/query", {
    method: "POST",
    body: {
      goal: "default context should not include runtime provenance events",
      include_records: false,
      include_views: false,
      limit: 5,
    },
  });
  const eventQuery = await request(store, "/context/query", {
    method: "POST",
    body: {
      goal: "inspect runtime provenance events",
      include_records: false,
      include_views: false,
      include_events: true,
      event_types: ["test.context_query_event"],
      limit: 5,
    },
  });

  assert.equal(defaultQuery.status, 200);
  assert.equal(defaultQuery.body.ok, true);
  assert.deepEqual(defaultQuery.body.pack.events, []);
  assert.equal(defaultQuery.body.pack.diagnostics.event_count, 0);
  assert.doesNotMatch(defaultQuery.body.pack.markdown, /Runtime Events/);

  assert.equal(eventQuery.status, 200);
  assert.equal(eventQuery.body.ok, true);
  assert.deepEqual(eventQuery.body.pack.events.map((item: { id: string }) => item.id), [event.id]);
  assert.equal(eventQuery.body.pack.diagnostics.event_count, 1);
  assert.match(eventQuery.body.pack.markdown, /## Runtime Events/);
  assert.match(eventQuery.body.pack.markdown, /test\.context_query_event/);
  assert.match(eventQuery.body.pack.markdown, /broker event provenance/);
}));

test("POST /context/query with query plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-query-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-query-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed query source", text: "shared query token allowed" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-query-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied query source", text: "shared query token DENIED QUERY CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/context/query?plugin_id=external-agent", {
      method: "POST",
      body: {
        query: "shared query token",
        include_records: true,
        include_views: false,
        limit: 10,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.pack.plugin_id, "external-agent");
    assert.equal(response.body.pack.diagnostics.plugin_loaded, true);
    assert.deepEqual(response.body.pack.records.map((record: { id: string }) => record.id), ["record:http-query-plugin-allowed"]);
    assert.doesNotMatch(response.body.pack.markdown, /DENIED QUERY CONTEXT SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/pack includes runtime events only when explicitly requested", async () => withStore(async (store) => {
  const event = store.appendRuntimeEvent({
    event_type: "test.context_pack_event",
    actor: "system",
    status: "completed",
    subject_type: "runtime",
    subject_id: "context-pack-test",
    payload: { reason: "pack event provenance" },
  });

  const defaultPack = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "default pack should not include runtime provenance events",
      limit: 5,
    },
  });
  const eventPack = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "inspect runtime provenance events",
      include_events: true,
      event_types: ["test.context_pack_event"],
      limit: 5,
    },
  });

  assert.equal(defaultPack.status, 200);
  assert.equal(defaultPack.body.ok, true);
  assert.deepEqual(defaultPack.body.pack.events, []);
  assert.equal(defaultPack.body.pack.diagnostics.event_count, 0);
  assert.doesNotMatch(defaultPack.body.pack.markdown, /Runtime Events/);

  assert.equal(eventPack.status, 200);
  assert.equal(eventPack.body.ok, true);
  assert.deepEqual(eventPack.body.pack.events.map((item: { id: string }) => item.id), [event.id]);
  assert.equal(eventPack.body.pack.diagnostics.event_count, 1);
  assert.match(eventPack.body.pack.markdown, /## Runtime Events/);
  assert.match(eventPack.body.pack.markdown, /test\.context_pack_event/);
  assert.match(eventPack.body.pack.markdown, /pack event provenance/);
}));

test("POST /context/pack can include derived Views for Application and agent consumption", async () => withStore(async (store) => {
  store.upsertView({
    id: "brief:http-pack-research",
    view_type: "brief.research",
    title: "Research brief",
    summary: "A reusable research brief for the active topic.",
    status: "accepted",
    content: {
      thesis: "Views should circulate through context packs.",
    },
  });

  const defaultPack = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "default pack keeps legacy record-only behavior unless views are requested",
      limit: 5,
    },
  });
  const viewPack = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "load reusable research views",
      include_views: true,
      view_types: ["brief.research"],
      limit: 5,
    },
  });

  assert.equal(defaultPack.status, 200);
  assert.equal(defaultPack.body.ok, true);
  assert.deepEqual(defaultPack.body.pack.views, []);
  assert.equal(defaultPack.body.pack.diagnostics.view_count, 0);
  assert.doesNotMatch(defaultPack.body.pack.markdown, /Derived Views/);

  assert.equal(viewPack.status, 200);
  assert.equal(viewPack.body.ok, true);
  assert.deepEqual(viewPack.body.pack.views.map((view: { id: string }) => view.id), ["brief:http-pack-research"]);
  assert.equal(viewPack.body.pack.diagnostics.view_count, 1);
  assert.match(viewPack.body.pack.markdown, /## Derived Views/);
  assert.match(viewPack.body.pack.markdown, /brief\.research/);
  assert.match(viewPack.body.pack.markdown, /Views should circulate through context packs/);
}));

test("POST /context/pack repo scope excludes explicit other repos but keeps project-scoped evidence", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-pack-same-repo",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { title: "Same repo", text: "repo scope sentinel same repository evidence" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-pack-project-only",
    schema: { name: "observation.git.diff", version: 1 },
    source: { type: "git", connector: "local" },
    scope: { project_path: "/Users/junjie/info", app: "terminal" },
    content: { title: "Project diff", text: "repo scope sentinel project-only evidence without explicit repo" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-pack-other-repo",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Other repo", text: "repo scope sentinel other repository evidence must not leak" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-pack-same-repo",
    view_type: "analysis.github_issue",
    title: "Same repo analysis",
    summary: "repo scope sentinel same repo view",
    source_records: ["record:http-pack-same-repo"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "same repo view" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-pack-project-only",
    view_type: "analysis.project_local",
    title: "Project-only analysis",
    summary: "repo scope sentinel project-only view without explicit repo",
    source_records: ["record:http-pack-project-only"],
    scope: { project_path: "/Users/junjie/info" },
    content: { analysis: "project-only view" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-pack-other-repo",
    view_type: "analysis.github_issue",
    title: "Other repo analysis",
    summary: "repo scope sentinel other repo view must not leak",
    source_records: ["record:http-pack-other-repo"],
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "other repo view" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "repo scope sentinel",
      include_records: true,
      include_views: true,
      view_types: ["analysis.github_issue", "analysis.project_local"],
      scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
      limit: 8,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.pack.views.map((view: { id: string }) => view.id).sort(),
    ["analysis:http-pack-project-only", "analysis:http-pack-same-repo"].sort(),
  );
  assert.deepEqual(
    response.body.pack.records.map((record: { id: string }) => record.id).sort(),
    ["record:http-pack-project-only", "record:http-pack-same-repo"].sort(),
  );
  assert.doesNotMatch(response.body.pack.markdown, /other repository evidence must not leak/);
  assert.doesNotMatch(response.body.pack.markdown, /other repo view must not leak/);
}));

test("POST /context/pack filters included Views by goal keywords", async () => withStore(async (store) => {
  store.upsertView({
    id: "brief:http-pack-runtime",
    view_type: "brief.research",
    title: "Agent runtime architecture",
    summary: "Runtime architecture notes for ambient context systems.",
    status: "accepted",
    content: { thesis: "Program attention routes Observations into reusable Views." },
  });
  store.upsertView({
    id: "brief:http-pack-cooking",
    view_type: "brief.research",
    title: "Cooking notes",
    summary: "Recipe ideas for breakfast.",
    status: "accepted",
    content: { thesis: "Use low heat for eggs." },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "ambient agent runtime architecture",
      include_views: true,
      view_types: ["brief.research"],
      limit: 5,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["brief:http-pack-runtime"]);
  assert.match(response.body.pack.markdown, /Program attention routes Observations/);
  assert.doesNotMatch(response.body.pack.markdown, /low heat for eggs/);
}));

test("POST /context/pack filters included Views by standardized agent_output", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-pack-agent-output-match",
    view_type: "analysis.browser_agent_task",
    title: "Browser AgentTask analysis",
    status: "accepted",
    content: {
      agent_output: {
        summary: "Browser analysis",
        analysis: "The agent found reusable context graph routing details.",
      },
    },
  });
  store.upsertView({
    id: "analysis:http-pack-agent-output-miss",
    view_type: "analysis.browser_agent_task",
    title: "Unrelated AgentTask analysis",
    status: "accepted",
    content: {
      agent_output: {
        summary: "Browser analysis",
        analysis: "The agent found unrelated setup notes.",
      },
    },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "context graph routing",
      include_views: true,
      view_types: ["analysis.browser_agent_task"],
      limit: 5,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-pack-agent-output-match"]);
  assert.match(response.body.pack.markdown, /context graph routing/);
  assert.doesNotMatch(response.body.pack.markdown, /unrelated setup notes/);
}));


test("POST /context/pack ignores Views Events and surfacing memory with invalid provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-pack-valid-view-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "example.com" },
    content: { title: "Valid pack source", text: "Valid pack source context" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-pack-dirty-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "other.example" },
    content: { title: "DIRTY PACK SOURCE SHOULD NOT LEAK", text: "Dirty context" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:http-pack-dirty-surfacing",
    view_type: "memory.surfacing_preference",
    source_records: ["record:http-pack-dirty-source"],
    scope: { domain: "example.com" },
    content: { preference: "show_less", target_view_type: "analysis.browser_page" },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-pack-repo-older-default",
    view_type: "analysis.repo",
    title: "Older repo analysis",
    content: { analysis: "Older repo analysis should not win without valid memory." },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-pack-browser-newer-valid",
    view_type: "analysis.browser_page",
    title: "Newer valid browser analysis",
    source_records: ["record:http-pack-valid-view-source"],
    scope: { domain: "example.com" },
    content: { analysis: "Newer valid browser analysis should win when dirty memory is ignored." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-pack-browser-dirty",
    view_type: "analysis.browser_page",
    title: "DIRTY PACK VIEW SHOULD NOT LEAK",
    source_records: ["record:http-pack-dirty-source"],
    scope: { domain: "example.com" },
    content: { analysis: "DIRTY PACK VIEW SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  const visibleEvent = store.appendRuntimeEvent({
    event_type: "timeline_view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "view",
    subject_id: "analysis:http-pack-browser-newer-valid",
    related_records: ["record:http-pack-valid-view-source"],
    related_views: ["analysis:http-pack-browser-newer-valid"],
    payload: { title: "Visible pack event" },
  });
  store.appendRuntimeEvent({
    event_type: "timeline_view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "view",
    subject_id: "analysis:http-pack-missing-view",
    related_views: ["analysis:http-pack-missing-view"],
    payload: { title: "MISSING PACK EVENT VIEW SHOULD NOT LEAK" },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "valid browser analysis",
      include_views: true,
      include_records: true,
      include_events: true,
      view_type_prefix: "analysis.",
      event_types: ["timeline_view_compiled"],
      limit: 1,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-pack-browser-newer-valid"]);
  assert.deepEqual(response.body.pack.events.map((event: { id: string }) => event.id), [visibleEvent.id]);
  assert.deepEqual(response.body.pack.diagnostics.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: [],
    source_view_ids: [],
  });
  assert.doesNotMatch(response.body.pack.markdown, /DIRTY PACK|MISSING PACK/);
}));

test("POST /context/pack lowers dismissed View types using surfacing memory", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:http-pack-surfacing-dismissed-browser",
    view_type: "memory.surfacing_preference",
    title: "Show less browser analysis",
    content: {
      preference: "show_less",
      target_view_type: "analysis.browser_page",
    },
    confidence: 0.9,
  });
  store.upsertView({
    id: "analysis:http-pack-repo-preferred",
    view_type: "analysis.repo",
    title: "Repo analysis should win",
    content: { analysis: "Repo analysis should be selected before dismissed browser analysis." },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-pack-browser-dismissed-newer",
    view_type: "analysis.browser_page",
    title: "Newer dismissed browser analysis",
    content: { analysis: "Dismissed browser analysis should be lowered." },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "analysis",
      include_views: true,
      view_type_prefix: "analysis.",
      limit: 1,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-pack-repo-preferred"]);
  assert.deepEqual(response.body.pack.diagnostics.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:http-pack-surfacing-dismissed-browser"],
  });
  assert.match(response.body.pack.markdown, /Repo analysis should be selected/);
  assert.doesNotMatch(response.body.pack.markdown, /Dismissed browser analysis should be lowered/);
}));

test("POST /context/pack with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-pack-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-pack-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Allowed source", text: "ALLOWED HTTP PLUGIN PACK CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-pack-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Denied source", text: "DENIED HTTP PLUGIN PACK CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:http-pack-plugin-allowed",
      view_type: "analysis.browser_page",
      title: "Allowed analysis",
      scope: { domain: "example.com" },
      source_records: ["record:http-pack-plugin-allowed"],
      content: { analysis: "Allowed HTTP plugin pack analysis." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-pack-plugin-denied",
      view_type: "analysis.browser_page",
      title: "Denied analysis",
      scope: { domain: "example.com" },
      source_records: ["record:http-pack-plugin-denied"],
      content: { analysis: "DENIED HTTP PLUGIN PACK ANALYSIS SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/context/pack", {
      method: "POST",
      body: {
        plugin_id: "external-agent",
        goal: "plugin pack context",
        include_views: true,
        include_records: true,
        view_types: ["analysis.browser_page"],
        scope: { domain: "example.com" },
        limit: 8,
      },
    });
    const queryParamResponse = await request(store, "/context/pack?plugin_id=external-agent", {
      method: "POST",
      body: {
        goal: "plugin pack context",
        include_views: true,
        include_records: true,
        include_screenpipe: true,
        include_ai_sessions: true,
        view_types: ["analysis.browser_page"],
        scope: { domain: "example.com" },
        limit: 8,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.pack.plugin_id, "external-agent");
    assert.equal(response.body.pack.diagnostics.plugin_loaded, true);
    assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-pack-plugin-allowed"]);
    assert.deepEqual(response.body.pack.records.map((record: { id: string }) => record.id), ["record:http-pack-plugin-allowed"]);
    assert.match(response.body.pack.markdown, /ALLOWED HTTP PLUGIN PACK CONTEXT/);
    assert.doesNotMatch(response.body.pack.markdown, /DENIED HTTP PLUGIN PACK CONTEXT SHOULD NOT LEAK/);
    assert.doesNotMatch(response.body.pack.markdown, /DENIED HTTP PLUGIN PACK ANALYSIS SHOULD NOT LEAK/);

    assert.equal(queryParamResponse.status, 200);
    assert.equal(queryParamResponse.body.pack.plugin_id, "external-agent");
    assert.equal(queryParamResponse.body.pack.diagnostics.plugin_loaded, true);
    assert.deepEqual(queryParamResponse.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-pack-plugin-allowed"]);
    assert.deepEqual(queryParamResponse.body.pack.records.map((record: { id: string }) => record.id), ["record:http-pack-plugin-allowed"]);
    assert.equal(queryParamResponse.body.pack.diagnostics.screenpipe, undefined);
    assert.equal(queryParamResponse.body.pack.diagnostics.ai_sessions, undefined);
    assert.doesNotMatch(queryParamResponse.body.pack.markdown, /DENIED HTTP PLUGIN PACK CONTEXT SHOULD NOT LEAK/);
    assert.doesNotMatch(queryParamResponse.body.pack.markdown, /DENIED HTTP PLUGIN PACK ANALYSIS SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/pack with plugin_id does not let hidden context starve visible Views and Observations", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-pack-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "pack-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "pack-reader", "plugin.json"), JSON.stringify({
      id: "pack-reader",
      name: "Pack Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-pack-starvation-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Visible pack source", text: "shared pack starvation token visible context" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-pack-starvation-visible",
      view_type: "analysis.browser_page",
      title: "Visible pack analysis",
      status: "candidate",
      scope: { domain: "example.com" },
      source_records: ["record:http-pack-starvation-visible"],
      content: { analysis: "shared pack starvation token visible analysis" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertRecord({
        id: `record:http-pack-starvation-hidden-${index}`,
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser" },
        scope: { domain: "example.com" },
        content: { title: `Hidden pack source ${index}`, text: `shared pack starvation token HIDDEN PACK CONTEXT ${index}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
      store.upsertView({
        id: `analysis:http-pack-starvation-hidden-${index}`,
        view_type: "analysis.browser_page",
        title: `Hidden pack analysis ${index}`,
        status: "candidate",
        scope: { domain: "example.com" },
        source_records: [`record:http-pack-starvation-hidden-${index}`],
        content: { analysis: `shared pack starvation token HIDDEN PACK ANALYSIS ${index}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      });
    }

    const response = await request(store, "/context/pack?plugin_id=pack-reader", {
      method: "POST",
      body: {
        goal: "shared pack starvation token",
        include_views: true,
        include_records: true,
        view_types: ["analysis.browser_page"],
        scope: { domain: "example.com" },
        limit: 8,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.pack.plugin_id, "pack-reader");
    assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["analysis:http-pack-starvation-visible"]);
    assert.deepEqual(response.body.pack.records.map((record: { id: string }) => record.id), ["record:http-pack-starvation-visible"]);
    assert.match(response.body.pack.markdown, /visible context/);
    assert.match(response.body.pack.markdown, /visible analysis/);
    assert.doesNotMatch(response.body.pack.markdown, /HIDDEN PACK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/pack with plugin_id uses canonical event source URIs", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-pack-event-source-uri-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "event-pack-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "event-pack-reader", "plugin.json"), JSON.stringify({
      id: "event-pack-reader",
      name: "Event Pack Reader",
      permissions: {
        allowed_event_types: ["program.run.completed"],
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const event = store.appendRuntimeEvent({
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      subject_type: "program",
      subject_id: "program.browser_ambient",
      plugin_id: "event-pack-reader",
      payload: { reason: "canonical event source uri" },
    });

    const response = await request(store, "/context/pack?plugin_id=event-pack-reader", {
      method: "POST",
      body: {
        goal: "canonical event source uri",
        include_records: false,
        include_views: false,
        include_events: true,
        limit: 5,
      },
    });
    const eventSource = response.body.pack.sources.find((source: { id: string; kind: string }) => source.kind === "event" && source.id === event.id);

    assert.equal(response.status, 200);
    assert.ok(eventSource);
    assert.equal(eventSource.uri, `context://events/${event.id}`);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("POST /context/pack exposes record View and event sources for provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-pack-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Runtime page", text: "ambient runtime source evidence" },
  });
  store.upsertView({
    id: "brief:http-pack-source-view",
    view_type: "brief.research",
    title: "Runtime source View",
    summary: "ambient runtime source View",
    status: "accepted",
    source_records: ["record:http-pack-source"],
    content: { thesis: "source provenance should be inspectable" },
  });
  const event = store.appendRuntimeEvent({
    event_type: "test.context_pack_source_event",
    actor: "system",
    status: "completed",
    subject_type: "view",
    subject_id: "brief:http-pack-source-view",
    related_records: ["record:http-pack-source"],
    related_views: ["brief:http-pack-source-view"],
    payload: { reason: "source list provenance" },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "ambient runtime source",
      include_views: true,
      include_events: true,
      view_types: ["brief.research"],
      event_types: ["test.context_pack_source_event"],
      limit: 5,
    },
  });
  const sources = response.body.pack.sources as Array<{ id: string; kind: string; uri?: string; title?: string }>;

  assert.equal(response.status, 200);
  assert.ok(sources.some(source => source.kind === "record" && source.id === "record:http-pack-source" && source.uri === "context://records/record:http-pack-source"));
  assert.ok(sources.some(source => source.kind === "view" && source.id === "brief:http-pack-source-view" && source.uri === "context://views/brief:http-pack-source-view"));
  assert.ok(sources.some(source => source.kind === "event" && source.id === event.id && source.uri === `context://events/${event.id}`));
}));

test("POST /context/pack includes source_records for included Views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-pack-hidden-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Raw captured page",
      text: "opaque captured evidence that does not share the query words",
    },
  });
  store.upsertView({
    id: "brief:http-pack-with-source-record",
    view_type: "brief.research",
    title: "Ambient runtime brief",
    summary: "ambient runtime synthesis",
    status: "accepted",
    source_records: ["record:http-pack-hidden-source"],
    content: { thesis: "derived View should carry its evidence record into the pack" },
  });
  for (let i = 0; i < 6; i += 1) {
    store.insertRecord({
      id: `record:http-pack-decoy-${i}`,
      schema: { name: "observation.browser_page_snapshot", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: {
        title: `Decoy ${i}`,
        text: "unrelated fresh record",
      },
    });
  }

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "ambient runtime synthesis",
      include_views: true,
      view_types: ["brief.research"],
      limit: 1,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), ["brief:http-pack-with-source-record"]);
  assert.equal(response.body.pack.diagnostics.provenance_record_count, 1);
  assert.deepEqual(response.body.pack.diagnostics.provenance_record_ids, ["record:http-pack-hidden-source"]);
  assert.ok(response.body.pack.records.some((record: { id: string }) => record.id === "record:http-pack-hidden-source"));
  assert.ok(response.body.pack.sources.some((source: { kind: string; id: string }) => source.kind === "record" && source.id === "record:http-pack-hidden-source"));
}));

test("POST /context/pack includes direct source_views for included Views", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-pack-source-view",
    view_type: "analysis.browser_page",
    title: "Raw page analysis",
    summary: "lower-level source View",
    status: "accepted",
    content: { analysis: "source View evidence should remain inspectable" },
  });
  store.upsertView({
    id: "brief:http-pack-derived-view",
    view_type: "brief.research",
    title: "Ambient runtime derived brief",
    summary: "ambient runtime synthesis",
    status: "accepted",
    source_views: ["analysis:http-pack-source-view"],
    content: { thesis: "derived View should carry direct source_views into the pack" },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "ambient runtime synthesis",
      include_views: true,
      view_types: ["brief.research"],
      limit: 5,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), [
    "brief:http-pack-derived-view",
    "analysis:http-pack-source-view",
  ]);
  assert.ok(response.body.pack.sources.some((source: { kind: string; id: string }) => source.kind === "view" && source.id === "analysis:http-pack-source-view"));
  assert.match(response.body.pack.markdown, /source View evidence should remain inspectable/);
}));

test("POST /context/pack expands nested source_views within a bounded provenance chain", async () => withStore(async (store) => {
  store.upsertView({
    id: "extraction:http-pack-nested",
    view_type: "extraction.pdf_text",
    title: "PDF extraction",
    summary: "lowest-level extracted evidence",
    status: "accepted",
    content: { text: "nested source View evidence should remain inspectable" },
  });
  store.upsertView({
    id: "analysis:http-pack-nested",
    view_type: "analysis.browser_page",
    title: "Browser analysis",
    summary: "middle-level analysis",
    status: "accepted",
    source_views: ["extraction:http-pack-nested"],
    content: { analysis: "analysis depends on extraction" },
  });
  store.upsertView({
    id: "brief:http-pack-nested",
    view_type: "brief.research",
    title: "Ambient nested runtime brief",
    summary: "ambient nested runtime synthesis",
    status: "accepted",
    source_views: ["analysis:http-pack-nested"],
    content: { thesis: "top-level brief depends on analysis" },
  });

  const response = await request(store, "/context/pack", {
    method: "POST",
    body: {
      goal: "ambient nested runtime synthesis",
      include_views: true,
      view_types: ["brief.research"],
      limit: 8,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pack.views.map((view: { id: string }) => view.id), [
    "brief:http-pack-nested",
    "analysis:http-pack-nested",
    "extraction:http-pack-nested",
  ]);
  assert.match(response.body.pack.markdown, /nested source View evidence should remain inspectable/);
}));

test("POST /context/views with plugin_id requires write permission and produced View type", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-view-write-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "writer"), { recursive: true });
    writeFileSync(join(dir, "plugins", "writer", "plugin.json"), JSON.stringify({
      id: "writer",
      name: "Writer",
      view_types_produced: ["analysis.browser_page"],
      permissions: {
        allow_write_views: true,
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));
    mkdirSync(join(dir, "plugins", "reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "reader", "plugin.json"), JSON.stringify({
      id: "reader",
      name: "Reader",
      view_types_produced: ["analysis.browser_page"],
      permissions: {
        allow_write_views: false,
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-plugin-view-write-allowed-source",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { text: "allowed source record" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-plugin-view-write-denied-source",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { text: "DENIED SOURCE RECORD SHOULD NOT BECOME VIEW PROVENANCE" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const deniedByWrite = await request(store, "/context/views?plugin_id=reader", {
      method: "POST",
      body: {
        id: "analysis:http-plugin-write-denied",
        view_type: "analysis.browser_page",
        content: { analysis: "DENIED VIEW WRITE SHOULD NOT PERSIST" },
      },
    });
    const deniedByType = await request(store, "/context/views?plugin_id=writer", {
      method: "POST",
      body: {
        id: "project:http-plugin-write-denied-type",
        view_type: "project.current_context",
        content: { analysis: "DENIED VIEW TYPE SHOULD NOT PERSIST" },
      },
    });
    const deniedByProvenance = await request(store, "/context/views?plugin_id=writer", {
      method: "POST",
      body: {
        id: "analysis:http-plugin-write-denied-provenance",
        view_type: "analysis.browser_page",
        source_records: ["record:http-plugin-view-write-denied-source"],
        content: { analysis: "DENIED VIEW PROVENANCE SHOULD NOT PERSIST" },
      },
    });
    const deniedByMissingProvenance = await request(store, "/context/views?plugin_id=writer", {
      method: "POST",
      body: {
        id: "analysis:http-plugin-write-missing-provenance",
        view_type: "analysis.browser_page",
        source_records: ["record:http-plugin-view-write-missing-source"],
        source_views: ["analysis:http-plugin-view-write-missing-source-view"],
        content: { analysis: "MISSING VIEW PROVENANCE SHOULD NOT PERSIST" },
      },
    });
    const deniedByBodyPlugin = await request(store, "/context/views", {
      method: "POST",
      body: {
        id: "analysis:http-plugin-write-denied-body-plugin",
        view_type: "analysis.browser_page",
        scope: { plugin_id: "reader" },
        content: { analysis: "DENIED BODY PLUGIN VIEW SHOULD NOT PERSIST" },
      },
    });
    const allowed = await request(store, "/context/views?plugin_id=writer", {
      method: "POST",
      body: {
        id: "analysis:http-plugin-write-allowed",
        view_type: "analysis.browser_page",
        source_records: ["record:http-plugin-view-write-allowed-source"],
        content: { analysis: "allowed plugin view write" },
      },
    });

    assert.equal(deniedByWrite.status, 403);
    assert.equal(deniedByWrite.body.ok, false);
    assert.equal(deniedByWrite.body.error, "plugin cannot write views");
    assert.equal(store.getView("analysis:http-plugin-write-denied"), undefined);

    assert.equal(deniedByType.status, 403);
    assert.equal(deniedByType.body.ok, false);
    assert.equal(deniedByType.body.error, "plugin cannot write this view_type");
    assert.equal(store.getView("project:http-plugin-write-denied-type"), undefined);

    assert.equal(deniedByProvenance.status, 403);
    assert.equal(deniedByProvenance.body.ok, false);
    assert.equal(deniedByProvenance.body.error, "plugin cannot reference this view provenance");
    assert.equal(store.getView("analysis:http-plugin-write-denied-provenance"), undefined);
    assert.equal(deniedByMissingProvenance.status, 403);
    assert.equal(deniedByMissingProvenance.body.ok, false);
    assert.equal(deniedByMissingProvenance.body.error, "plugin cannot reference this view provenance");
    assert.equal(store.getView("analysis:http-plugin-write-missing-provenance"), undefined);

    assert.equal(deniedByBodyPlugin.status, 403);
    assert.equal(deniedByBodyPlugin.body.ok, false);
    assert.equal(deniedByBodyPlugin.body.error, "plugin cannot write views");
    assert.equal(store.getView("analysis:http-plugin-write-denied-body-plugin"), undefined);

    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.ok, true);
    assert.equal(allowed.body.view.id, "analysis:http-plugin-write-allowed");
    assert.deepEqual(allowed.body.view.source_records, ["record:http-plugin-view-write-allowed-source"]);
    assert.equal(allowed.body.view.scope.plugin_id, "writer");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/views rejects record-like and malformed View types", async () => withStore(async (store) => {
  const derived = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "derived:http-direct-view-write",
      view_type: "derived.project_memory",
      content: { analysis: "DERIVED VIEW TYPE SHOULD NOT PERSIST" },
    },
  });
  const malformed = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "analysis:http-direct-malformed-view-write",
      view_type: "analysis/bad",
      content: { analysis: "MALFORMED VIEW TYPE SHOULD NOT PERSIST" },
    },
  });

  assert.equal(derived.status, 400);
  assert.equal(derived.body.ok, false);
  assert.equal(store.getView("derived:http-direct-view-write"), undefined);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.ok, false);
  assert.equal(store.getView("analysis:http-direct-malformed-view-write"), undefined);
}));

test("GET /context/views/catalog exposes unified View families and manual-create options", async () => withStore(async (store) => {
  const response = await request(store, "/context/views/catalog");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(response.body.order.includes("evidence"));
  assert.ok(response.body.order.includes("project.current_context"));
  assert.equal(response.body.order.includes("task.toolsmith_prototype"), false);
  const project = response.body.families.find((family: any) => family.view_type === "project.current_context");
  assert.equal(project.label, "Project Context");
  assert.equal(project.category, "project");
  const manualTypes = new Set(response.body.manual_create.map((family: any) => family.view_type));
  assert.ok(manualTypes.has("project.current_context"));
  assert.ok(manualTypes.has("task.background_research"));
  assert.equal(manualTypes.has("task.toolsmith_prototype"), false);
}));

test("POST /context/views can mark manually created Views through the shared catalog", async () => withStore(async (store) => {
  const response = await request(store, "/context/views?source=manual", {
    method: "POST",
    body: {
      id: "project:http-manual-create-view",
      view_type: "project.current_context",
      title: "Manual project context",
      summary: "Created through the generic Create View path.",
      content: { note: "manual view content" },
      privacy: { level: "private", retention: "normal" },
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.view.compiler.id, "manual.create_view");
  assert.equal(response.body.view.metadata.created_via, "manual_create_view");
  assert.equal(response.body.view.metadata.view_family.label, "Project Context");
  assert.equal(response.body.view.metadata.view_family.category, "project");
}));

test("POST /context/views rejects legacy non-observation source Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-view-legacy-source",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy source", text: "LEGACY VIEW SOURCE SHOULD NOT BE REFERENCED" },
  });

  const response = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "analysis:http-view-legacy-provenance",
      view_type: "analysis.browser_page",
      source_records: ["record:http-view-legacy-source"],
      content: { analysis: "VIEW WITH LEGACY SOURCE SHOULD NOT PERSIST" },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view cannot reference this record");
  assert.equal(store.getView("analysis:http-view-legacy-provenance"), undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /LEGACY VIEW SOURCE SHOULD NOT BE REFERENCED/);
}));

test("POST /context/views rejects missing provenance references", async () => withStore(async (store) => {
  const missingRecord = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "analysis:http-view-missing-record-source",
      view_type: "analysis.browser_page",
      source_records: ["record:http-view-missing-source"],
      content: { analysis: "VIEW WITH MISSING RECORD SOURCE SHOULD NOT PERSIST" },
    },
  });
  const missingView = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "analysis:http-view-missing-view-source",
      view_type: "analysis.browser_page",
      source_views: ["analysis:http-view-missing-source-view"],
      content: { analysis: "VIEW WITH MISSING VIEW SOURCE SHOULD NOT PERSIST" },
    },
  });

  assert.equal(missingRecord.status, 403);
  assert.equal(missingRecord.body.ok, false);
  assert.equal(missingRecord.body.error, "view cannot reference this record");
  assert.equal(store.getView("analysis:http-view-missing-record-source"), undefined);

  assert.equal(missingView.status, 403);
  assert.equal(missingView.body.ok, false);
  assert.equal(missingView.body.error, "view cannot reference this source view");
  assert.equal(store.getView("analysis:http-view-missing-view-source"), undefined);
}));

test("POST /context/views rejects scope conflicting with source Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-view-scope-source-repo",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { title: "Issue #1", text: "Source belongs to example/repo." },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "analysis:http-view-scope-conflict",
      view_type: "analysis.github_issue",
      source_records: ["record:http-view-scope-source-repo"],
      scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
      content: { analysis: "This View scope contradicts its source Record." },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view scope conflicts with provenance");
  assert.equal(store.getView("analysis:http-view-scope-conflict"), undefined);
}));

test("POST /context/views rejects scope conflicting with source Views", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-view-scope-source-view",
    view_type: "analysis.github_issue",
    title: "Source View",
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "Source View belongs to example/repo." },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views", {
    method: "POST",
    body: {
      id: "brief:http-view-scope-conflict-source-view",
      view_type: "brief.research",
      source_views: ["analysis:http-view-scope-source-view"],
      scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
      content: { analysis: "This View scope contradicts its source View." },
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view scope conflicts with provenance");
  assert.equal(store.getView("brief:http-view-scope-conflict-source-view"), undefined);
}));

test("GET /context/views exposes Application-safe View filters", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "HTTP source" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-active",
    view_type: "analysis.browser_page",
    status: "accepted",
    compiler: { id: "program.browser_ambient", mode: "deterministic" },
    source_records: ["record:http-source"],
    content: { analysis: "active http view" },
  });
  store.upsertView({
    id: "analysis:http-archived",
    view_type: "analysis.browser_page",
    status: "archived",
    compiler: { id: "program.browser_ambient", mode: "deterministic" },
    source_records: ["record:http-source"],
    content: { analysis: "archived http view" },
  });

  const response = await request(store, "/context/views?view_types=analysis.browser_page&active_only=true&compiler_id=program.browser_ambient&source_record_id=record%3Ahttp-source");
  const body = response.body as { ok: boolean; views: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-active"]);
}));

test("GET /context/views summary includes lightweight AudioView fields", async () => withStore(async (store) => {
  store.upsertView({
    id: "audio:http-summary",
    view_type: "audio",
    status: "candidate",
    title: "Audio summary",
    summary: "Audio semantic summary",
    content: {
      kind: "audio",
      transcript_excerpt: "我们需要把 audio view 显示完整一点",
      speaker_label: "speaker:7",
      device_name: "EarPods Microphone",
      transcript_quality: "clear",
      topics: ["AudioView", "UI"],
    },
  });

  const response = await request(store, "/context/views?view_types=audio&active_only=true&summary_only=true&limit=20");
  const body = response.body as { ok: boolean; views: Array<{ content?: Record<string, unknown> }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.views[0].content?.transcript_excerpt, "我们需要把 audio view 显示完整一点");
  assert.equal(body.views[0].content?.device_name, "EarPods Microphone");
  assert.deepEqual(body.views[0].content?.topics, ["AudioView", "UI"]);
}));

test("GET /context/views can return all Views for an Application list", async () => withStore(async (store) => {
  for (let index = 0; index < 70; index += 1) {
    store.upsertView({
      id: `evidence:http-all-${String(index).padStart(2, "0")}`,
      view_type: "evidence",
      status: "candidate",
      title: `Evidence ${index}`,
      content: { kind: "screen", index },
    });
  }

  const response = await request(store, "/context/views?view_types=evidence&active_only=true&summary_only=true&limit=all");
  const body = response.body as { ok: boolean; views: Array<{ id: string; content?: Record<string, unknown> }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.views.length, 70);
  assert.deepEqual(new Set(body.views.map(view => view.id)), new Set(Array.from({ length: 70 }, (_, index) => `evidence:http-all-${String(index).padStart(2, "0")}`)));
}));

test("GET /context/views backfills after provenance filtering recent invalid Views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-backfill-valid",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Valid source" },
    privacy: { level: "private", retention: "normal" },
  });
  for (let index = 0; index < 70; index += 1) {
    store.upsertView({
      id: `memory:http-backfill-valid-${String(index).padStart(2, "0")}`,
      view_type: "memory",
      status: "candidate",
      title: `Valid memory ${index}`,
      source_records: ["record:http-backfill-valid"],
      content: { kind: "episode", index },
    });
  }
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 180; index += 1) {
    store.upsertView({
      id: `memory:http-backfill-invalid-${String(index).padStart(3, "0")}`,
      view_type: "memory",
      status: "candidate",
      title: `Invalid memory ${index}`,
      source_records: [`record:missing-${index}`],
      content: { kind: "episode", index },
    });
  }

  const response = await request(store, "/context/views?view_types=memory&active_only=true&summary_only=true&limit=60");
  const body = response.body as { ok: boolean; views: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.views.length, 60);
  assert.equal(body.views.every(view => view.id.startsWith("memory:http-backfill-valid-")), true);
}));

test("GET /context/views tolerates legacy malformed source_views JSON", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-legacy-view-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Legacy malformed View source" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-legacy-malformed-source-views",
    view_type: "analysis.browser_page",
    status: "accepted",
    source_records: ["record:http-legacy-view-source"],
    source_views: [],
    content: { analysis: "legacy View should not break subscriptions" },
  });
  (store as any).db.prepare(`update context_views set source_views_json = '{}' where id = ?`).run("analysis:http-legacy-malformed-source-views");

  const response = await request(store, "/context/views?view_types=analysis.browser_page&active_only=true");
  const body = response.body as { ok: boolean; views: Array<{ id: string; source_views?: string[] }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-legacy-malformed-source-views"]);
  assert.deepEqual(body.views[0].source_views, []);
}));

test("GET /context/views supports View type prefix filtering", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-browser-prefix",
    view_type: "analysis.browser_page",
    content: { analysis: "browser" },
  });
  store.upsertView({
    id: "analysis:http-repo-prefix",
    view_type: "analysis.repo",
    content: { analysis: "repo" },
  });
  store.upsertView({
    id: "project:http-context-prefix",
    view_type: "project.current_context",
    content: { analysis: "project" },
  });

  const response = await request(store, "/context/views?view_type_prefix=analysis.");
  const body = response.body as { ok: boolean; views: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(
    new Set(body.views.map(view => view.id)),
    new Set(["analysis:http-browser-prefix", "analysis:http-repo-prefix"]),
  );
}));

test("GET /context/views supports project and repo scoped View subscriptions", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-views-same-repo-scope",
    view_type: "analysis.github_issue",
    title: "Same repo scoped View",
    summary: "view subscription scope same repo",
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "same repo subscription view" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-views-project-only-scope",
    view_type: "analysis.project_local",
    title: "Project-only scoped View",
    summary: "view subscription scope project-only",
    scope: { project_path: "/Users/junjie/info" },
    content: { analysis: "project-only subscription view" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-views-other-repo-scope",
    view_type: "analysis.github_issue",
    title: "Other repo scoped View",
    summary: "view subscription scope other repo must not leak",
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "other repo subscription view" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views?view_type_prefix=analysis.&project_path=%2FUsers%2Fjunjie%2Finfo&domain=github.com&repo=example%2Frepo&limit=10");

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.views.map((view: { id: string }) => view.id).sort(),
    ["analysis:http-views-project-only-scope", "analysis:http-views-same-repo-scope"].sort(),
  );
  assert.doesNotMatch(JSON.stringify(response.body), /other repo subscription view/);
}));

test("GET /context/views excludes Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-views-scope-clean-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { title: "Clean source", text: "Clean subscription source." },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-views-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting source", text: "CONFLICTING SUBSCRIPTION SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-views-scope-clean",
    view_type: "analysis.github_issue",
    title: "Clean subscription View",
    source_records: ["record:http-views-scope-clean-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "Clean subscription View should be visible." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-views-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting subscription View",
    source_records: ["record:http-views-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING SUBSCRIPTION VIEW SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views?view_type_prefix=analysis.&project_path=%2FUsers%2Fjunjie%2Finfo&domain=github.com&repo=example%2Frepo&limit=10");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.views.map((view: { id: string }) => view.id), ["analysis:http-views-scope-clean"]);
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING SUBSCRIPTION/);
}));


test("GET /context/views ignores surfacing memory with invalid provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-dirty-surfacing-memory-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "other.example" },
    content: { title: "HTTP DIRTY SURFACING MEMORY SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:http-dirty-surfacing-browser",
    view_type: "memory.surfacing_preference",
    title: "Dirty show less browser analysis",
    source_records: ["record:http-dirty-surfacing-memory-source"],
    scope: { domain: "example.com" },
    content: { preference: "show_less", target_view_type: "analysis.browser_page" },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-repo-older-default",
    view_type: "analysis.repo",
    title: "Older repo analysis",
    content: { analysis: "Older repo analysis should not win over newer browser without valid memory." },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-browser-newer-default",
    view_type: "analysis.browser_page",
    title: "Newer browser analysis",
    content: { analysis: "Newer browser analysis should win when dirty HTTP memory is ignored." },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views?view_type_prefix=analysis.&limit=1");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.views.map((view: { id: string }) => view.id), ["analysis:http-browser-newer-default"]);
  assert.deepEqual(response.body.subscription.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: [],
    source_view_ids: [],
  });
  assert.doesNotMatch(JSON.stringify(response.body), /HTTP DIRTY SURFACING MEMORY/);
}));

test("GET /context/views lowers dismissed View types using surfacing memory", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:http-views-surfacing-dismissed-browser",
    view_type: "memory.surfacing_preference",
    title: "Show less browser analysis",
    content: {
      preference: "show_less",
      target_view_type: "analysis.browser_page",
    },
    confidence: 0.9,
  });
  store.upsertView({
    id: "analysis:http-views-repo-preferred",
    view_type: "analysis.repo",
    title: "Repo analysis should win",
    content: { analysis: "Repo analysis should appear before dismissed browser analysis." },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-views-browser-dismissed-newer",
    view_type: "analysis.browser_page",
    title: "Newer dismissed browser analysis",
    content: { analysis: "Dismissed browser analysis should be lowered in subscriptions." },
  });

  const response = await request(store, "/context/views?view_type_prefix=analysis.&limit=1");
  const body = response.body as { ok: boolean; views: Array<{ id: string }>; subscription?: { surfacing_preferences?: unknown } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-views-repo-preferred"]);
  assert.deepEqual(body.subscription?.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:http-views-surfacing-dismissed-browser"],
  });
}));

test("GET /context/views with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-views-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-views-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Allowed source", text: "ALLOWED VIEW SUBSCRIPTION CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-views-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied source", text: "DENIED VIEW SUBSCRIPTION CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:http-views-plugin-allowed",
      view_type: "analysis.browser_page",
      title: "Allowed browser analysis",
      source_records: ["record:http-views-plugin-allowed"],
      content: { analysis: "Allowed View subscription analysis." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-views-plugin-denied",
      view_type: "analysis.browser_page",
      title: "Denied browser analysis",
      source_records: ["record:http-views-plugin-denied"],
      content: { analysis: "DENIED VIEW SUBSCRIPTION ANALYSIS SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-views-plugin-denied-source-type",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git" },
      content: { title: "Denied git source", text: "DENIED VIEW SOURCE TYPE SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-views-plugin-denied-source-type",
      view_type: "analysis.browser_page",
      title: "Denied source type analysis",
      source_records: ["record:http-views-plugin-denied-source-type"],
      content: { analysis: "DENIED VIEW DERIVED FROM GIT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:http-views-plugin-wrong-type",
      view_type: "analysis.repo",
      title: "Denied repo analysis",
      content: { analysis: "DENIED WRONG VIEW TYPE SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/context/views?plugin_id=external-agent&view_type_prefix=analysis.&limit=10");
    const body = response.body as { ok: boolean; views: Array<{ id: string; content?: { analysis?: string } }>; subscription?: { plugin_id?: string; plugin_loaded?: boolean } };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.views.map(view => view.id), ["analysis:http-views-plugin-allowed"]);
    assert.equal(body.subscription?.plugin_id, "external-agent");
    assert.equal(body.subscription?.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(body.views), /DENIED VIEW SUBSCRIPTION/);
    assert.doesNotMatch(JSON.stringify(body.views), /DENIED VIEW SOURCE TYPE/);
    assert.doesNotMatch(JSON.stringify(body.views), /DENIED VIEW DERIVED FROM GIT/);
    assert.doesNotMatch(JSON.stringify(body.views), /DENIED WRONG VIEW TYPE/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /context/views with unknown plugin_id does not fall back to unscoped Views", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-unknown-plugin-view",
    view_type: "analysis.browser_page",
    title: "Hidden analysis",
    content: { analysis: "UNKNOWN PLUGIN SHOULD NOT SEE THIS VIEW" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views?plugin_id=missing-plugin&view_type_prefix=analysis.&limit=10");

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN PLUGIN SHOULD NOT SEE/);
}));

test("GET /context/views with plugin_id does not let hidden Views starve visible subscription updates", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-views-plugin-cursor-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const cursor = store.upsertView({
      id: "analysis:http-plugin-cursor-before",
      view_type: "analysis.browser_page",
      content: { analysis: "before cursor" },
    }).updated_at;
    store.insertRecord({
      id: "record:http-plugin-cursor-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    const visible = store.upsertView({
      id: "analysis:http-plugin-cursor-visible",
      view_type: "analysis.browser_page",
      source_records: ["record:http-plugin-cursor-allowed"],
      content: { analysis: "visible after many hidden views" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    for (let i = 0; i < 25; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
      store.upsertView({
        id: `analysis:http-plugin-cursor-hidden-${i}`,
        view_type: "analysis.repo",
        content: { analysis: `hidden newer view ${i}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      });
    }

    const response = await request(store, `/context/views?plugin_id=external-agent&view_type_prefix=analysis.&cursor=${encodeURIComponent(cursor)}&limit=1`);
    const body = response.body as { ok: boolean; views: Array<{ id: string }>; next_cursor?: string };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.views.map(view => view.id), [visible.id]);
    assert.equal(body.next_cursor, visible.updated_at);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /feedback useful memory changes future context Views subscription over HTTP", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-feedback-views-agent-task",
    view_type: "analysis.browser_agent_task",
    title: "Useful AgentTask subscription context",
    content: { analysis: "Useful AgentTask analysis should be selected by Application subscriptions." },
    confidence: 0.82,
  });

  const feedback = await request(store, "/feedback?process=true", {
    method: "POST",
    body: {
      type: "analysis.useful",
      application_id: "browser.popup",
      view_id: "analysis:http-feedback-views-agent-task",
      value: "useful",
      reason: "show this kind of analysis in browser subscriptions",
    },
  });
  const feedbackBody = feedback.body as { ok: boolean; processing: { runs: Array<{ program_id: string; written_views: string[] }> } };
  const learningRun = feedbackBody.processing.runs.find(run => run.program_id === "program.feedback_learning");
  const memoryId = learningRun?.written_views[0];

  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-feedback-views-repo-newer",
    view_type: "analysis.repo",
    title: "Newer repo subscription context",
    content: { analysis: "Newer repo analysis should not win over useful AgentTask subscription type." },
  });

  const response = await request(store, "/context/views?view_type_prefix=analysis.&limit=1");
  const body = response.body as { ok: boolean; views: Array<{ id: string }>; subscription?: { surfacing_preferences?: unknown } };

  assert.equal(feedback.status, 201);
  assert.equal(feedbackBody.ok, true);
  assert.ok(memoryId);
  assert.equal(store.getView(memoryId)?.content?.preference, "show_more");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-feedback-views-agent-task"]);
  assert.deepEqual(body.subscription?.surfacing_preferences, {
    show_more_view_types: ["analysis.browser_agent_task"],
    show_less_view_types: [],
    source_view_ids: [memoryId],
  });
}));


test("GET /context/views can query standardized agent_output content", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-agent-output-match",
    view_type: "analysis.browser_agent_task",
    title: "Matched AgentTask View",
    content: {
      agent_output: {
        summary: "Browser page analysis",
        analysis: "This analysis mentions vectorized context routing for agent tasks.",
        key_points: ["context routing", "agent output"],
      },
    },
  });
  store.upsertView({
    id: "analysis:http-agent-output-miss",
    view_type: "analysis.browser_agent_task",
    title: "Unmatched AgentTask View",
    content: {
      agent_output: {
        summary: "Browser page analysis",
        analysis: "This analysis mentions only repository setup.",
        key_points: ["repo setup"],
      },
    },
  });

  const response = await request(store, "/context/views?view_types=analysis.browser_agent_task&query=vectorized");
  const body = response.body as { ok: boolean; views: Array<{ id: string; content?: { agent_output?: { analysis?: string } } }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-agent-output-match"]);
  assert.match(String(body.views[0].content?.agent_output?.analysis), /vectorized context routing/);
}));

test("GET /context/views supports updated_after for pull-based Application subscriptions", async () => withStore(async (store) => {
  const oldView = store.upsertView({
    id: "analysis:http-poll-old",
    view_type: "analysis.browser_page",
    content: { analysis: "old" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-poll-new",
    view_type: "analysis.browser_page",
    content: { analysis: "new" },
  });

  const response = await request(store, `/context/views?view_type_prefix=analysis.&updated_after=${encodeURIComponent(oldView.updated_at)}`);
  const body = response.body as { ok: boolean; views: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-poll-new"]);
}));

test("GET /context/views exposes a stable cursor for Application polling", async () => withStore(async (store) => {
  const oldView = store.upsertView({
    id: "analysis:http-cursor-old",
    view_type: "analysis.browser_page",
    content: { analysis: "old" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  const newView = store.upsertView({
    id: "analysis:http-cursor-new",
    view_type: "analysis.browser_page",
    content: { analysis: "new" },
  });

  const response = await request(store, `/context/views?view_type_prefix=analysis.&cursor=${encodeURIComponent(oldView.updated_at)}`);
  const body = response.body as { ok: boolean; views: Array<{ id: string }>; next_cursor?: string; subscription?: { cursor?: string; returned_count?: number } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-cursor-new"]);
  assert.equal(body.next_cursor, newView.updated_at);
  assert.equal(body.subscription?.cursor, newView.updated_at);
  assert.equal(body.subscription?.returned_count, 1);

  const emptyResponse = await request(store, `/context/views?view_type_prefix=analysis.&cursor=${encodeURIComponent(body.next_cursor ?? "")}`);
  const emptyBody = emptyResponse.body as { ok: boolean; views: Array<{ id: string }>; next_cursor?: string; subscription?: { cursor?: string; returned_count?: number } };
  assert.equal(emptyResponse.status, 200);
  assert.equal(emptyBody.ok, true);
  assert.deepEqual(emptyBody.views, []);
  assert.equal(emptyBody.next_cursor, newView.updated_at);
  assert.equal(emptyBody.subscription?.returned_count, 0);
}));

test("GET /context/views cursor remains time-safe when surfacing reorders results", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:http-cursor-surfacing-show-more-agent-task",
    view_type: "memory.surfacing_preference",
    content: {
      preference: "show_more",
      target_view_type: "analysis.browser_agent_task",
    },
    confidence: 0.9,
  });
  const cursorView = store.upsertView({
    id: "analysis:http-cursor-surfacing-before",
    view_type: "analysis.repo",
    content: { analysis: "before cursor" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  const preferredButOlder = store.upsertView({
    id: "analysis:http-cursor-surfacing-agent-task",
    view_type: "analysis.browser_agent_task",
    content: { analysis: "preferred by surfacing but older than neutral" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  const neutralButNewer = store.upsertView({
    id: "analysis:http-cursor-surfacing-repo",
    view_type: "analysis.repo",
    content: { analysis: "neutral but newest" },
  });

  const response = await request(store, `/context/views?view_type_prefix=analysis.&cursor=${encodeURIComponent(cursorView.updated_at)}&limit=2`);
  const body = response.body as { ok: boolean; views: Array<{ id: string }>; next_cursor?: string; subscription?: { cursor?: string; returned_count?: number } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), [preferredButOlder.id, neutralButNewer.id]);
  assert.equal(body.next_cursor, neutralButNewer.updated_at);
  assert.equal(body.subscription?.cursor, neutralButNewer.updated_at);
  assert.equal(body.subscription?.returned_count, 2);
}));

test("GET /context/views/latest lowers dismissed View types using surfacing memory", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:http-latest-surfacing-dismissed-browser",
    view_type: "memory.surfacing_preference",
    title: "Show less browser analysis",
    content: {
      preference: "show_less",
      target_view_type: "analysis.browser_page",
    },
    confidence: 0.9,
  });
  store.upsertView({
    id: "analysis:http-latest-repo-preferred",
    view_type: "analysis.repo",
    title: "Repo analysis should win",
    content: { analysis: "Repo analysis should be latest after surfacing rank." },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-latest-browser-dismissed-newer",
    view_type: "analysis.browser_page",
    title: "Newer dismissed browser analysis",
    content: { analysis: "Dismissed browser analysis should not be latest." },
  });

  const response = await request(store, "/context/views/latest?view_type_prefix=analysis.");
  const body = response.body as { ok: boolean; view: { id: string }; surfacing_preferences?: unknown };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.view.id, "analysis:http-latest-repo-preferred");
  assert.deepEqual(body.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:http-latest-surfacing-dismissed-browser"],
  });
}));

test("GET /context/views/latest returns latest active View with optional provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-latest-source",
    schema: { name: "observation.git.diff", version: 1 },
    source: { type: "git" },
    content: { title: "Latest provenance record" },
  });
  store.upsertView({
    id: "project:http-latest-old",
    view_type: "project.current_context",
    content: { analysis: "old" },
  });
  store.upsertView({
    id: "project:http-latest-archived",
    view_type: "project.current_context",
    status: "archived",
    content: { analysis: "archived" },
  });
  store.upsertView({
    id: "project:http-latest-active",
    view_type: "project.current_context",
    source_records: ["record:http-latest-source"],
    content: { analysis: "active latest" },
  });

  const response = await request(store, "/context/views/latest?view_type_prefix=project.&include_provenance=true");
  const body = response.body as { ok: boolean; view: { id: string }; provenance: { records: Array<{ id: string }> } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.view.id, "project:http-latest-active");
  assert.deepEqual(body.provenance.records.map(record => record.id), ["record:http-latest-source"]);
}));

test("GET /context/views/latest supports project and repo scoped View selection", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-latest-same-repo-scope",
    view_type: "analysis.github_issue",
    title: "Same repo latest scoped View",
    summary: "latest scope same repo",
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "same repo latest view" },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-latest-other-repo-scope",
    view_type: "analysis.github_issue",
    title: "Other repo latest scoped View",
    summary: "latest scope other repo must not leak",
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "other repo latest view" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views/latest?view_type_prefix=analysis.&project_path=%2FUsers%2Fjunjie%2Finfo&domain=github.com&repo=example%2Frepo");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.view.id, "analysis:http-latest-same-repo-scope");
  assert.doesNotMatch(JSON.stringify(response.body), /other repo latest view/);
}));

test("GET /context/views/latest excludes Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-latest-scope-clean-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { title: "Clean latest source", text: "Clean latest source." },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-latest-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting latest source", text: "CONFLICTING LATEST SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-latest-scope-clean",
    view_type: "analysis.github_issue",
    title: "Clean latest View",
    source_records: ["record:http-latest-scope-clean-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "Clean latest View should be selected." },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-latest-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting latest View",
    source_records: ["record:http-latest-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING LATEST VIEW SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views/latest?view_type_prefix=analysis.&project_path=%2FUsers%2Fjunjie%2Finfo&domain=github.com&repo=example%2Frepo");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.view.id, "analysis:http-latest-scope-clean");
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING LATEST/);
}));

test("GET /context/views/latest with plugin_id filters included provenance", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-latest-provenance-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "project-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "project-reader", "plugin.json"), JSON.stringify({
      id: "project-reader",
      name: "Project Reader",
      permissions: {
        allowed_view_types: ["project.current_context"],
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.upsertView({
      id: "analysis:http-latest-provenance-denied-source-view",
      view_type: "analysis.browser_page",
      content: { analysis: "DENIED LATEST PROVENANCE SOURCE VIEW SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal" },
    });
    store.upsertView({
      id: "project:http-latest-provenance-root",
      view_type: "project.current_context",
      source_views: ["analysis:http-latest-provenance-denied-source-view"],
      content: { analysis: "allowed root project view" },
      privacy: { level: "private", retention: "normal" },
    });

    const response = await request(store, "/context/views/latest?plugin_id=project-reader&view_type_prefix=project.&include_provenance=true");

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.view.id, "project:http-latest-provenance-root");
    assert.deepEqual(response.body.provenance.views.map((view: { id: string }) => view.id), ["project:http-latest-provenance-root"]);
    assert.doesNotMatch(JSON.stringify(response.body.provenance), /DENIED LATEST PROVENANCE SOURCE VIEW SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /context/views/latest with plugin_id does not let hidden Views starve visible latest View", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-latest-plugin-starve-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "project-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "project-reader", "plugin.json"), JSON.stringify({
      id: "project-reader",
      name: "Project Reader",
      permissions: {
        allowed_view_types: ["project.current_context"],
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const visible = store.upsertView({
      id: "project:http-latest-visible-after-hidden",
      view_type: "project.current_context",
      content: { analysis: "visible latest after many hidden views" },
      privacy: { level: "private", retention: "normal" },
    });
    for (let i = 0; i < 25; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
      store.upsertView({
        id: `project:http-latest-hidden-${i}`,
        view_type: "project.private_context",
        content: { analysis: `hidden latest view ${i}` },
        privacy: { level: "private", retention: "normal" },
      });
    }

    const response = await request(store, "/context/views/latest?plugin_id=project-reader&view_type_prefix=project.");

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.view.id, visible.id);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("GET /context/views/latest with unknown plugin_id does not fall back to unscoped View", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-latest-unknown-plugin-view",
    view_type: "analysis.browser_page",
    title: "Hidden latest analysis",
    content: { analysis: "UNKNOWN LATEST PLUGIN SHOULD NOT SEE THIS VIEW" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/context/views/latest?plugin_id=missing-plugin&view_type_prefix=analysis.");

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN LATEST PLUGIN SHOULD NOT SEE/);
}));
test("GET /context/views/latest can query standardized agent_output content", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-latest-agent-output-match",
    view_type: "analysis.browser_agent_task",
    title: "Older matched AgentTask View",
    content: {
      agent_output: {
        summary: "Older browser analysis",
        analysis: "This older analysis mentions ambient query routing.",
      },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:http-latest-agent-output-miss",
    view_type: "analysis.browser_agent_task",
    title: "Newer unmatched AgentTask View",
    content: {
      agent_output: {
        summary: "Newer browser analysis",
        analysis: "This newer analysis mentions unrelated repository setup.",
      },
    },
  });

  const response = await request(store, "/context/views/latest?view_types=analysis.browser_agent_task&query=ambient");
  const body = response.body as { ok: boolean; view: { id: string; content?: { agent_output?: { analysis?: string } } } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.view.id, "analysis:http-latest-agent-output-match");
  assert.match(String(body.view.content?.agent_output?.analysis), /ambient query routing/);
}));

test("POST /context/ingest can process Programs immediately", async () => withStore(async (store) => {
  const response = await request(store, "/context/ingest?process=true", {
    method: "POST",
    body: {
      id: "record:http-ingest-process-browser",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      content: {
        title: "example/repo",
        url: "https://github.com/example/repo",
        text: "Example repository README for an ambient runtime.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    },
  });
  const body = response.body as { ok: boolean; processing: { runs: Array<{ written_views: string[] }> } };
  const writtenViews = body.processing.runs.flatMap(run => run.written_views);
  const analysisView = writtenViews.map(id => store.getView(id)).find(view => view?.view_type === "analysis.browser_agent_task");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(analysisView);
  assert.equal(analysisView.compiler?.id, "capability.agent_task.submit");
}));

test("POST /context/ingest skips processing for deduped browser snapshots", async () => withStore(async (store) => {
  const snapshot = {
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: {
      title: "Agent Runtime Architecture Paper",
      url: "https://example.com/agent-runtime-paper.pdf",
      text: "Agent runtime architecture paper text. Context graphs and program attention make ambient systems composable.",
    },
    payload: { dedupe_window_seconds: 300 },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  };
  const first = await request(store, "/context/ingest?process=true&cascade_views=true", {
    method: "POST",
    body: { ...snapshot, id: "record:http-dedupe-browser-snapshot-1" },
  });
  const programRunsAfterFirst = store.listRuntimeEvents({ event_type: "program.run.started", limit: 50 }).length;

  const second = await request(store, "/context/ingest?process=true&cascade_views=true", {
    method: "POST",
    body: { ...snapshot, id: "record:http-dedupe-browser-snapshot-2" },
  });
  const programRunsAfterSecond = store.listRuntimeEvents({ event_type: "program.run.started", limit: 50 }).length;

  assert.equal(first.status, 201);
  assert.equal(first.body.deduped, false);
  assert.ok(first.body.processing);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.duplicate_of, "record:http-dedupe-browser-snapshot-1");
  assert.equal(Object.hasOwn(second.body, "processing"), false);
  assert.equal(Object.hasOwn(second.body, "cascade_processing"), false);
  assert.equal(programRunsAfterSecond, programRunsAfterFirst);

  const dedupedEvent = store.listRuntimeEvents({ event_type: "record_deduped", subject_id: "record:http-dedupe-browser-snapshot-1", limit: 1 })[0];
  assert.ok(dedupedEvent);
  assert.equal(dedupedEvent.payload?.duplicate_of, "record:http-dedupe-browser-snapshot-1");
}));

test("POST /context/ingest does not dedupe explicit browser ambient requests", async () => withStore(async (store) => {
  const requestBody = {
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: {
      title: "Agent Runtime Architecture Paper",
      url: "https://example.com/agent-runtime-paper.pdf",
      text: "Agent runtime architecture paper text. Context graphs and program attention make ambient systems composable.",
    },
    payload: { dedupe_window_seconds: 300, request: { kind: "ambient_explore" } },
    acquisition: { mode: "manual", actor: "user", reason: "ambient explore button" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  };

  const first = await request(store, "/context/ingest?process=true", {
    method: "POST",
    body: { ...requestBody, id: "record:http-manual-ambient-1" },
  });
  const second = await request(store, "/context/ingest?process=true", {
    method: "POST",
    body: { ...requestBody, id: "record:http-manual-ambient-2" },
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.deduped, false);
  assert.equal(second.body.deduped, false);
  assert.ok(first.body.processing);
  assert.ok(second.body.processing);
  assert.ok(store.getRecord("record:http-manual-ambient-1"));
  assert.ok(store.getRecord("record:http-manual-ambient-2"));
}));

test("POST /context/ingest can cascade generated Views into proactive ambient work", async () => withStore(async (store) => {
  const response = await request(store, "/context/ingest?process=true&cascade_views=true", {
    method: "POST",
    body: {
      id: "record:http-ingest-cascade-browser",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      content: {
        title: "example/repo",
        url: "https://github.com/example/repo",
        text: "Example repository README for an ambient runtime.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    },
  });
  const body = response.body as {
    ok: boolean;
    processing: { runs: Array<{ written_views: string[] }> };
    cascade_processing: Array<{ cascade_depth?: number; runs: Array<{ program_id?: string; written_views: string[] }> }>;
  };
  const firstViews = body.processing.runs.flatMap(run => run.written_views);
  const cascadedViews = body.cascade_processing.flatMap(result => result.runs.flatMap(run => run.written_views));
  const cascadedViewTypes = cascadedViews.map(id => store.getView(id)?.view_type).filter(Boolean);

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(firstViews.some(id => store.getView(id)?.view_type === "analysis.browser_agent_task"));
  assert.ok(cascadedViews.some(id => store.getView(id)?.view_type === "project.current_context"));
  assert.ok(cascadedViews.some(id => store.getView(id)?.view_type === "thread.active_work"));
  assert.ok(cascadedViews.some(id => store.getView(id)?.view_type === "brief.project_next_state"));
  assert.ok(cascadedViewTypes.includes("task.background_research"));
  assert.ok(cascadedViewTypes.includes("advice.research"));
  assert.ok(body.cascade_processing.some(result => result.cascade_depth === 2 && result.runs.some(run => run.program_id === "program.proactive_research")));
}));

test("POST /context/ingest cascade with plugin_id keeps cascaded Program Context Packs policy-scoped", async () => {
  const cwd = process.cwd();
  const oldBrowserAmbientRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  const restoreBrowserAmbientAgents = suppressBrowserAmbientAgents();
  const dir = mkdtempSync(join(tmpdir(), "info-http-ingest-cascade-plugin-test-"));
  process.chdir(dir);
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    mkdirSync(join(dir, "plugins", "browser-plugin"), { recursive: true });
    writeFileSync(join(dir, "plugins", "browser-plugin", "plugin.json"), JSON.stringify({
      id: "browser-plugin",
      name: "Browser Plugin",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const projectPath = "/Users/junjie/info";
    store.insertRecord({
      id: "record:http-ingest-cascade-plugin-denied-llm",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com", repo: "example/repo", project_path: projectPath },
      content: {
        title: "Denied browser context",
        url: "https://github.com/example/secret",
        text: "DENIED INGEST CASCADE CONTEXT SHOULD NOT LEAK",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertRecord({
      id: "record:http-ingest-cascade-plugin-denied-source",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git", connector: "git" },
      scope: { project_path: projectPath },
      content: {
        title: "Denied git context",
        text: "DENIED INGEST GIT CASCADE CONTEXT SHOULD NOT LEAK",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/context/ingest?plugin_id=browser-plugin&process=true&cascade_views=true", {
      method: "POST",
      body: {
        id: "record:http-ingest-cascade-plugin-allowed",
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser", connector: "chrome-extension" },
        scope: { app: "chrome", domain: "github.com", repo: "example/repo", project_path: projectPath },
        content: {
          title: "Allowed browser context",
          url: "https://github.com/example/repo",
          text: "Allowed ingest cascade context should reach plugin-scoped Project Ambient.",
        },
        privacy: { level: "private", retention: "normal", allow_external_llm: true },
      },
    });
    const body = response.body as {
      ok: boolean;
      id: string;
      cascade_processing: Array<{ runs: Array<{ written_views: string[] }> }>;
    };
    const cascadedViewIds = body.cascade_processing.flatMap(result => result.runs.flatMap(run => run.written_views));
    const projectView = cascadedViewIds.map(id => store.getView(id)).find(view => view?.view_type === "project.current_context");
    const serialized = JSON.stringify(projectView);

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.id, "record:http-ingest-cascade-plugin-allowed");
    assert.ok(projectView);
    assert.ok(projectView.source_records?.includes("record:http-ingest-cascade-plugin-allowed"));
    assert.ok(!projectView.source_records?.includes("record:http-ingest-cascade-plugin-denied-llm"));
    assert.ok(!projectView.source_records?.includes("record:http-ingest-cascade-plugin-denied-source"));
    assert.doesNotMatch(serialized, /DENIED INGEST CASCADE CONTEXT/);
    assert.doesNotMatch(serialized, /DENIED INGEST GIT CASCADE CONTEXT/);
  } finally {
    restoreBrowserAmbientAgents();
    if (oldBrowserAmbientRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldBrowserAmbientRuntime;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /context/ingest cascade keeps Browser Ambient on generic AgentTask for repo pages", async () => withStore(async (store) => {
  const response = await request(store, "/context/ingest?process=true&cascade_views=true", {
    method: "POST",
    body: {
      id: "record:http-ingest-cascade-repo-capability",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      content: {
        title: "example/repo",
        url: "https://github.com/example/repo",
        text: "Example repository README for an ambient runtime.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    },
  });
  const body = response.body as {
    ok: boolean;
    processing: { runs: Array<{ written_views: string[]; diagnostics?: Record<string, unknown> }> };
    cascade_processing: Array<{ runs: Array<{ written_views: string[] }> }>;
  };
  const browserAnalysis = body.processing.runs.flatMap(run => run.written_views).map(id => store.getView(id)).find(view => view?.view_type === "analysis.browser_agent_task");
  const repo = store.listViews({ view_types: ["analysis.repo"], source_record_id: "record:http-ingest-cascade-repo-capability" })[0];
  const agentTaskView = store.listViews({ view_types: ["analysis.browser_agent_task"], source_record_id: "record:http-ingest-cascade-repo-capability" })[0];
  const fallbackAnalysis = store.listViews({ view_types: ["analysis.browser_page"], source_record_id: "record:http-ingest-cascade-repo-capability" })[0];
  const cascadedProjectViews = body.cascade_processing
    .flatMap(result => result.runs.flatMap(run => run.written_views))
    .map(id => store.getView(id))
    .filter(view => view?.view_type === "project.current_context");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(browserAnalysis);
  assert.equal(repo, undefined);
  assert.equal(fallbackAnalysis, undefined);
  assert.ok(agentTaskView);
  assert.equal(agentTaskView.compiler?.id, "capability.agent_task.submit");
  assert.equal(Object.hasOwn(agentTaskView.content?.agent_task as object, "skills"), false);
  assert.ok(cascadedProjectViews.some(view => view?.source_views?.includes(browserAnalysis.id)));
}));

test("POST /context/ingest cascade keeps Browser Ambient on generic AgentTask for PDF pages", async () => withStore(async (store) => {
  const response = await request(store, "/context/ingest?process=true&cascade_views=true", {
    method: "POST",
    body: {
      id: "record:http-ingest-cascade-pdf-capability",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "example.com" },
      content: {
        title: "Agent Runtime Architecture Paper",
        url: "https://example.com/agent-runtime-paper.pdf",
        text: "Agent runtime architecture paper text. Context graphs and program attention make ambient systems composable.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    },
  });
  const body = response.body as {
    ok: boolean;
    processing: { runs: Array<{ written_views: string[] }> };
    cascade_processing: Array<{ runs: Array<{ written_views: string[] }> }>;
  };
  const browserAnalysis = body.processing.runs.flatMap(run => run.written_views).map(id => store.getView(id)).find(view => view?.view_type === "analysis.browser_agent_task");
  const extraction = store.listViews({ view_types: ["extraction.pdf_text"], source_record_id: "record:http-ingest-cascade-pdf-capability" })[0];
  const agentTaskView = store.listViews({ view_types: ["analysis.browser_agent_task"], source_record_id: "record:http-ingest-cascade-pdf-capability" })[0];
  const fallbackAnalysis = store.listViews({ view_types: ["analysis.browser_page"], source_record_id: "record:http-ingest-cascade-pdf-capability" })[0];
  const cascadedResearchBriefs = body.cascade_processing
    .flatMap(result => result.runs.flatMap(run => run.written_views))
    .map(id => store.getView(id))
    .filter(view => view?.view_type === "brief.research");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(browserAnalysis);
  assert.equal(extraction, undefined);
  assert.equal(fallbackAnalysis, undefined);
  assert.ok(agentTaskView);
  assert.equal(agentTaskView.compiler?.id, "capability.agent_task.submit");
  assert.equal(Object.hasOwn(agentTaskView.content?.agent_task as object, "skills"), false);
  assert.ok(cascadedResearchBriefs.some(view => view?.source_views?.includes(browserAnalysis.id)));
}));

test("POST /programs/process writes Program output to the HTTP store", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-program-process-browser",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "github.com" },
    content: {
      title: "example/repo",
      url: "https://github.com/example/repo",
      text: "Example repository README for program processing.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/programs/process", {
    method: "POST",
    body: {
      record_id: record.id,
      program_id: "program.browser_ambient",
    },
  });
  const body = response.body as { runs: Array<{ written_views: string[] }> };
  const viewId = body.runs[0].written_views[0];

  assert.equal(response.status, 200);
  assert.ok(viewId);
  assert.equal(store.getView(viewId)?.view_type, "analysis.browser_agent_task");
}));

test("POST /writing/assist runs only the writing Program fast path", async () => withStore(async (store) => {
  const oldScaffold = process.env.WRITING_AMBIENT_ENABLE_SCAFFOLD;
  const oldBase = process.env.LLM_BASE_URL;
  const oldModel = process.env.LLM_MODEL;
  process.env.WRITING_AMBIENT_ENABLE_SCAFFOLD = "1";
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  try {
    const response = await request(store, "/writing/assist", {
      method: "POST",
      body: {
        schema: { name: "observation.editor.text_changed", version: 1 },
        source: { type: "browser", connector: "chrome-extension" },
        scope: { app: "chrome", domain: "example.com" },
        content: {
          title: "Browser writing input",
          url: "https://example.com/editor",
          text: "I am writing about ambient suggestion design and need concise help near the cursor.",
        },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
        signal: { importance: 0.78, confidence: 0.86, status: "inbox" },
        payload: { writing_surface: "browser_inline" },
      },
    });
    const body = response.body as { ok: boolean; fast_path: boolean; written_views: string[]; views: Array<{ view_type: string }>; processing: { runs: Array<{ program_id: string }> } };

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.fast_path, true);
    assert.ok(body.written_views.length >= 1);
    assert.deepEqual([...new Set(body.processing.runs.map(run => run.program_id))], ["program.writing_ambient"]);
    assert.ok(body.views.some(view => view.view_type === "advice.writing_assist"));
    assert.equal(store.listViews({ view_types: ["work_thread"], limit: 10 }).length, 0);
  } finally {
    if (oldScaffold === undefined) delete process.env.WRITING_AMBIENT_ENABLE_SCAFFOLD;
    else process.env.WRITING_AMBIENT_ENABLE_SCAFFOLD = oldScaffold;
    if (oldBase === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = oldModel;
  }
}));

test("POST /programs/process rejects legacy non-observation Record sources", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-process-legacy-source",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy process source", text: "LEGACY PROGRAM PROCESS SOURCE SHOULD NOT RUN" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const response = await request(store, "/programs/process", {
    method: "POST",
    body: {
      record_id: "record:http-process-legacy-source",
      program_id: "program.browser_ambient",
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "record not found");
  assert.equal(store.listViews({ view_types: ["analysis.browser_agent_task"] }).length, 0);
  assert.doesNotMatch(JSON.stringify(response.body), /LEGACY PROGRAM PROCESS SOURCE SHOULD NOT RUN/);
}));

test("POST /programs/process fallback ignores newer legacy Records", async () => withStore(async (store) => {
  const visible = store.insertRecord({
    id: "record:http-process-fallback-visible",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "github.com" },
    content: {
      title: "Visible fallback process page",
      url: "https://github.com/example/repo",
      text: "VISIBLE PROGRAM PROCESS FALLBACK SHOULD RUN",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.insertRecord({
    id: "record:http-process-fallback-legacy-newer",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Newer legacy process source", text: "NEWER LEGACY PROGRAM PROCESS SOURCE SHOULD NOT RUN" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const response = await request(store, "/programs/process", {
    method: "POST",
    body: { program_id: "program.browser_ambient" },
  });
  const writtenViewIds = response.body.runs.flatMap((run: { written_views: string[] }) => run.written_views);
  const writtenViews = writtenViewIds.map((id: string) => store.getView(id)).filter(Boolean);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(writtenViews.some((view: any) => view.source_records?.includes(visible.id)));
  assert.doesNotMatch(JSON.stringify(writtenViews), /NEWER LEGACY PROGRAM PROCESS SOURCE SHOULD NOT RUN/);
}));



test("POST /programs/process with unknown plugin_id does not process unscoped context", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-process-unknown-plugin",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden process source", text: "UNKNOWN PROCESS PLUGIN SHOULD NOT SEE THIS RECORD" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/programs/process?plugin_id=missing-plugin", {
    method: "POST",
    body: { record_id: "record:http-process-unknown-plugin", dry_run: true },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN PROCESS PLUGIN SHOULD NOT SEE/);
}));
test("POST /programs/process with plugin_id gates source access and Program Context Packs", async () => {
  const cwd = process.cwd();
  const oldBrowserAmbientRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  const restoreBrowserAmbientAgents = suppressBrowserAmbientAgents();
  const dir = mkdtempSync(join(tmpdir(), "info-http-program-process-plugin-test-"));
  process.chdir(dir);
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    mkdirSync(join(dir, "plugins", "program-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "program-client", "plugin.json"), JSON.stringify({
      id: "program-client",
      name: "Program Client",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const allowed = store.insertRecord({
      id: "record:http-program-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      content: {
        title: "example/repo",
        url: "https://github.com/example/repo",
        text: "Analyze Allowed Program context should be visible for browser observation generic AgentTask boundary.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-program-plugin-denied-privacy",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      content: {
        title: "example/secret",
        url: "https://github.com/example/secret",
        text: "Analyze DENIED PROGRAM CONTEXT SHOULD NOT LEAK for browser observation generic AgentTask boundary",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const deniedSource = store.insertRecord({
      id: "record:http-program-plugin-denied-source",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git", connector: "git" },
      content: { text: "git source is outside plugin permission" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const denied = await request(store, "/programs/process?plugin_id=program-client", {
      method: "POST",
      body: {
        record_id: deniedSource.id,
        program_id: "program.browser_ambient",
      },
    });
    const response = await request(store, "/programs/process?plugin_id=program-client", {
      method: "POST",
      body: {
        record_id: allowed.id,
        program_id: "program.browser_ambient",
      },
    });
    const agentTaskView = store.listViews({ view_types: ["analysis.browser_agent_task"], limit: 1 })[0];

    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "plugin cannot access program process source");
    assert.equal(denied.body.plugin_id, "program-client");
    assert.equal(denied.body.plugin_loaded, true);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.plugin_id, "program-client");
    assert.equal(response.body.plugin_loaded, true);
    assert.ok(agentTaskView);
    assert.match(String(agentTaskView.content?.context_pack_markdown_excerpt), /Allowed Program context/);
    assert.doesNotMatch(String(agentTaskView.content?.context_pack_markdown_excerpt), /DENIED PROGRAM CONTEXT/);
  } finally {
    restoreBrowserAmbientAgents();
    if (oldBrowserAmbientRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldBrowserAmbientRuntime;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /programs/process with plugin_id fallback does not let hidden records starve visible source", async () => {
  const cwd = process.cwd();
  const oldBrowserAmbientRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  const restoreBrowserAmbientAgents = suppressBrowserAmbientAgents();
  const dir = mkdtempSync(join(tmpdir(), "info-http-program-process-fallback-starvation-test-"));
  process.chdir(dir);
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    mkdirSync(join(dir, "plugins", "program-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "program-reader", "plugin.json"), JSON.stringify({
      id: "program-reader",
      name: "Program Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const visible = store.insertRecord({
      id: "record:http-program-fallback-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "example.com" },
      content: {
        title: "Visible fallback page",
        url: "https://example.com/visible",
        text: "VISIBLE PROGRAM FALLBACK CONTEXT",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertRecord({
        id: `record:http-program-fallback-hidden-${index}`,
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser", connector: "chrome-extension" },
        scope: { app: "chrome", domain: "example.com" },
        content: {
          title: `Hidden fallback page ${index}`,
          url: `https://example.com/hidden-${index}`,
          text: `HIDDEN PROGRAM FALLBACK CONTEXT ${index}`,
        },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
    }

    const response = await request(store, "/programs/process?plugin_id=program-reader", {
      method: "POST",
      body: { program_id: "program.browser_ambient" },
    });
    const writtenViewIds = response.body.runs.flatMap((run: { written_views: string[] }) => run.written_views);
    const writtenViews = writtenViewIds.map((id: string) => store.getView(id)).filter(Boolean);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(writtenViews.some((view: any) => view.source_records?.includes(visible.id)));
    assert.doesNotMatch(JSON.stringify(writtenViews), /HIDDEN PROGRAM FALLBACK/);
  } finally {
    restoreBrowserAmbientAgents();
    if (oldBrowserAmbientRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldBrowserAmbientRuntime;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /programs/process rejects view_id whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-program-view-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting program source", text: "CONFLICTING PROGRAM SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-program-view-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting Program source View",
    source_records: ["record:http-program-view-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING PROGRAM VIEW SHOULD NOT RUN" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/programs/process", {
    method: "POST",
    body: {
      view_id: "analysis:http-program-view-scope-conflict",
      program_id: "program.project_ambient",
      dry_run: true,
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view not found");
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING PROGRAM/);
}));

test("POST /agent-tasks submits a generic AgentTask and writes returned Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-agent-task-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: {
      title: "Issue #9: generic agent task",
      url: "https://github.com/example/repo/issues/9",
      text: "Use a generic agent runtime task instead of adding one-off domain capabilities.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const response = await request(store, "/agent-tasks", {
    method: "POST",
    body: {
      record_id: record.id,
      autonomy: "suggest",
      task: {
        runtime: "local_mock",
        goal: "Analyze this issue through the generic agent task boundary.",
        constraints: { write_policy: "views_only" },
        output_contract: {
          view_type: "analysis.http_agent_task",
          title: "HTTP agent task analysis",
        },
      },
    },
  });
  const body = response.body as { ok: boolean; result: { written_views: string[] } };
  const view = store.getView(body.result.written_views[0]);

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(view);
  assert.equal(view.view_type, "analysis.http_agent_task");
  assert.equal(view.compiler?.id, "capability.agent_task.submit");
  assert.deepEqual(view.source_records, [record.id]);
  assert.equal((view.content?.agent_task as { runtime?: string; skills?: unknown }).runtime, "local_mock");
  assert.equal(Object.hasOwn(view.content?.agent_task as object, "skills"), false);
  assert.equal(typeof view.content?.agent_output?.summary, "string");
  assert.ok(Array.isArray(view.content?.agent_output?.key_points));
  assert.equal(view.content?.agent_output?.output_contract?.view_type, "analysis.http_agent_task");

  const submitted = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const completed = store.listRuntimeEvents({ event_type: "agent_task.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  assert.ok(submitted);
  assert.ok(completed);
  assert.equal(submitted.payload?.runtime, "local_mock");
  assert.equal((submitted.payload as any)?.skills, undefined);
  assert.deepEqual(completed.related_views, [view.id]);
  assert.equal(completed.payload?.output_contract?.view_type, "analysis.http_agent_task");
  assert.equal(completed.payload?.output_view_id, view.id);
  assert.equal((completed.payload as any)?.agent_output, undefined);

  const eventsResponse = await request(store, "/runtime/events?type=agent_task.completed&plugin=capability.agent_task.submit&limit=1");
  const event = eventsResponse.body.events[0];
  assert.equal(eventsResponse.status, 200);
  assert.equal(event.payload.output_contract.view_type, "analysis.http_agent_task");
  assert.equal(event.payload.output_view_id, view.id);
  assert.equal(event.payload.agent_output, undefined);
}));

test("POST /agent-tasks builds a Context Pack when task context_pack is omitted", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-agent-task-auto-pack-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: {
      title: "Issue #12: automatically build context pack",
      url: "https://github.com/example/repo/issues/12",
      text: "Automatically build context pack for agent task from the selected Observation and matching workspace context.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const supportingView = store.upsertView({
    id: "analysis:http-agent-task-auto-pack-support",
    view_type: "analysis.github_issue",
    title: "Automatically build context pack supporting analysis",
    summary: "Supporting View should be included in the automatic AgentTask Context Pack.",
    source_records: [record.id],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "Supporting automatic context pack analysis for the selected issue." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const otherRepoRecord = store.insertRecord({
    id: "record:http-agent-task-auto-pack-other-repo",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: {
      title: "Issue #44: automatically build context pack",
      url: "https://github.com/other/repo/issues/44",
      text: "Automatically build context pack for a different repository.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "analysis:http-agent-task-auto-pack-other-repo",
    view_type: "analysis.github_issue",
    title: "Other repo automatic context pack analysis",
    summary: "This other-repo View must not be included in the automatic AgentTask Context Pack.",
    source_records: [otherRepoRecord.id],
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "Other repository automatic context pack analysis must not leak into this task." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/agent-tasks", {
    method: "POST",
    body: {
      record_id: record.id,
      autonomy: "suggest",
      task: {
        runtime: "local_mock",
        goal: "Analyze this through automatically built Info context.",
        output_contract: {
          view_type: "analysis.http_auto_context_pack",
          title: "HTTP auto context pack",
        },
      },
    },
  });
  const body = response.body as { ok: boolean; result: { diagnostics: Record<string, unknown>; written_views: string[] } };
  const view = store.getView(body.result.written_views[0]);

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(view);
  assert.equal(view.view_type, "analysis.http_auto_context_pack");
  assert.deepEqual(view.source_records, [record.id]);
  assert.deepEqual(view.source_views, [supportingView.id]);
  assert.equal((view.content?.agent_task as { runtime?: string; skills?: unknown }).runtime, "local_mock");
  assert.equal(Object.hasOwn(view.content?.agent_task as object, "skills"), false);
  assert.match(String(view.content?.context_pack_markdown_excerpt), /# Context Broker Pack/);
  assert.match(String(view.content?.context_pack_markdown_excerpt), /Automatically build context pack for agent task/);
  assert.equal(body.result.diagnostics.context_source_count, 2);

  const submitted = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  assert.ok(submitted);
  assert.equal(submitted.payload?.goal, "Analyze this through automatically built Info context.");
  assert.deepEqual(submitted.related_records, [record.id]);
  assert.deepEqual(submitted.related_views, [supportingView.id]);
}));

test("POST /agent-tasks rejects caller-selected skills and tools", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-agent-task-skills-tools",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    content: { title: "Invalid AgentTask skills", text: "HTTP AgentTask should not select runtime skills or tools." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/agent-tasks", {
    method: "POST",
    body: {
      record_id: record.id,
      autonomy: "suggest",
      task: {
        runtime: "local_mock",
        goal: "Analyze without caller-selected skills.",
        skills: ["github.inspect_repo"],
        tools: ["pdf.extract"],
        output_contract: {
          view_type: "analysis.http_agent_task_with_skills",
          title: "Invalid HTTP skillful task",
        },
      },
    },
  });
  const body = response.body as { ok: boolean; result: { reason?: string; written_views: string[] } };

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.result.reason ?? "", /must not include skills or tools/);
  assert.deepEqual(body.result.written_views, []);
  assert.equal(store.listViews({ view_types: ["analysis.http_agent_task_with_skills"] }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
  const events = store.listRuntimeEvents({ plugin_id: "capability.agent_task.submit", limit: 5 });
  const serialized = JSON.stringify(events.map(event => event.payload));
  assert.doesNotMatch(serialized, /github\.inspect_repo|pdf\.extract/);
}));

test("POST /agent-tasks rejects record-like output_contract view types", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-agent-task-invalid-view-type",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    content: { title: "Invalid AgentTask output type", text: "AgentTask should only write valid View types." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/agent-tasks", {
    method: "POST",
    body: {
      record_id: record.id,
      task: {
        runtime: "local_mock",
        goal: "Do not write a derived record schema through AgentTask.",
        output_contract: {
          view_type: "episode.project_work",
          title: "Invalid episode output",
        },
      },
    },
  });
  const body = response.body as { ok: boolean; result: { reason?: string; written_views: string[] } };

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.result.reason ?? "", /must be a View type/);
  assert.deepEqual(body.result.written_views, []);
  assert.equal(store.listViews({ view_types: ["episode.project_work"] }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
}));

test("POST /agent-tasks rejects legacy non-observation Record sources", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-agent-task-legacy-source",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy source", text: "LEGACY AGENT TASK SOURCE SHOULD NOT RUN" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const response = await request(store, "/agent-tasks", {
    method: "POST",
    body: {
      record_id: "record:http-agent-task-legacy-source",
      task: {
        runtime: "local_mock",
        goal: "Do not run AgentTask over legacy Record sources.",
        output_contract: {
          view_type: "analysis.http_agent_task_legacy_source",
          title: "Invalid legacy source",
        },
      },
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "record not found");
  assert.equal(store.listViews({ view_types: ["analysis.http_agent_task_legacy_source"] }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
  assert.doesNotMatch(JSON.stringify(response.body), /LEGACY AGENT TASK SOURCE SHOULD NOT RUN/);
}));

test("POST /agent-tasks rejects view_id whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-agent-task-view-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting AgentTask source", text: "CONFLICTING AGENT TASK SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-agent-task-view-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting AgentTask source View",
    source_records: ["record:http-agent-task-view-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING AGENT TASK VIEW SHOULD NOT RUN" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/agent-tasks", {
    method: "POST",
    body: {
      view_id: "analysis:http-agent-task-view-scope-conflict",
      dry_run: true,
      task: {
        runtime: "local_mock",
        goal: "This dirty View must not reach AgentTask.",
        output_contract: {
          view_type: "analysis.http_agent_task_scope_conflict",
          title: "Dirty View AgentTask",
        },
      },
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view not found");
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING AGENT TASK/);
  assert.equal(store.listViews({ view_types: ["analysis.http_agent_task_scope_conflict"] }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
}));

test("POST /agent-tasks with plugin_id gates source access and automatic Context Pack", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-agent-task-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "agent-plugin"), { recursive: true });
	    writeFileSync(join(dir, "plugins", "agent-plugin", "plugin.json"), JSON.stringify({
	      id: "agent-plugin",
	      name: "Agent Plugin",
	      view_types_produced: ["analysis.plugin_agent_task"],
	      permissions: {
	        allowed_sources: ["browser"],
	        allowed_schemas: ["observation.browser_ambient_requested"],
	        max_privacy_level: "private",
	        allow_external_llm: true,
	        allow_write_views: true,
	      },
	    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const allowed = store.insertRecord({
      id: "record:http-agent-task-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { domain: "github.com", project_path: "/Users/junjie/info" },
      content: {
        title: "Allowed browser context",
        url: "https://github.com/example/repo",
        text: "Allowed AgentTask context should be available to this plugin.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-agent-task-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { domain: "github.com", project_path: "/Users/junjie/info" },
      content: {
        title: "Denied browser context",
        url: "https://github.com/example/secret",
        text: "DENIED AGENT TASK CONTEXT SHOULD NOT LEAK",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const disallowedSource = store.insertRecord({
      id: "record:http-agent-task-plugin-git",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git", connector: "git" },
      content: { text: "git source is outside plugin permission" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

	    const denied = await request(store, "/agent-tasks?plugin_id=agent-plugin", {
      method: "POST",
      body: {
        record_id: disallowedSource.id,
        autonomy: "suggest",
        task: {
          runtime: "local_mock",
          goal: "Try to analyze a denied source.",
          output_contract: { view_type: "analysis.plugin_agent_task_denied", title: "Denied plugin task" },
        },
	      },
	    });
	    const deniedViewType = await request(store, "/agent-tasks?plugin_id=agent-plugin", {
	      method: "POST",
	      body: {
	        record_id: allowed.id,
	        autonomy: "suggest",
	        task: {
	          runtime: "local_mock",
	          goal: "Try to write a View type outside plugin manifest.",
	          output_contract: { view_type: "analysis.plugin_agent_task_unlisted", title: "Unlisted plugin task" },
	        },
	      },
	    });
	    const response = await request(store, "/agent-tasks?plugin_id=agent-plugin", {
      method: "POST",
      body: {
        record_id: allowed.id,
        autonomy: "suggest",
        task: {
          runtime: "local_mock",
          goal: "Analyze allowed context without leaking denied context.",
          context_pack: {
            markdown: "CLIENT SUPPLIED CONTEXT PACK SHOULD BE REPLACED. DENIED AGENT TASK CONTEXT SHOULD NOT LEAK",
            sources: [{ id: "record:http-agent-task-plugin-denied", kind: "record" }],
            diagnostics: { client_supplied: true },
          },
          output_contract: { view_type: "analysis.plugin_agent_task", title: "Plugin AgentTask" },
        },
      },
    });
    const body = response.body as { ok: boolean; plugin_id?: string; plugin_loaded?: boolean; result: { diagnostics: Record<string, unknown>; written_views: string[] } };
    const view = store.getView(body.result.written_views[0]);

    assert.equal(denied.status, 403);
	    assert.equal(denied.body.error, "plugin cannot access agent task source");
	    assert.equal(denied.body.plugin_id, "agent-plugin");
	    assert.equal(denied.body.plugin_loaded, true);
	    assert.equal(deniedViewType.status, 403);
	    assert.equal(deniedViewType.body.error, "plugin cannot write this view_type");

	    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.plugin_id, "agent-plugin");
    assert.equal(body.plugin_loaded, true);
    assert.equal(body.result.diagnostics.context_source_count, 1);
    assert.ok(view);
    assert.equal(view.view_type, "analysis.plugin_agent_task");
    assert.match(String(view.content?.context_pack_markdown_excerpt), /Allowed AgentTask context/);
    assert.match(String(view.content?.context_pack_markdown_excerpt), /# Context Broker Pack/);
    assert.doesNotMatch(String(view.content?.context_pack_markdown_excerpt), /CLIENT SUPPLIED CONTEXT PACK/);
    assert.doesNotMatch(String(view.content?.context_pack_markdown_excerpt), /DENIED AGENT TASK CONTEXT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /agent-tasks can cascade returned AgentTask Views into Programs", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:http-agent-task-cascade-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: {
      title: "example/repo",
      url: "https://github.com/example/repo",
      text: "Agent runtime architecture repository with context graph and research notes.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/agent-tasks?cascade_views=true", {
    method: "POST",
    body: {
      record_id: record.id,
      autonomy: "suggest",
      task: {
        runtime: "local_mock",
        goal: "Analyze this repository architecture for project and research context.",
        output_contract: {
          view_type: "analysis.http_agent_task_cascade",
          title: "HTTP AgentTask cascade analysis",
        },
      },
    },
  });
  const body = response.body as { ok: boolean; result: { written_views: string[] }; cascade_processing: Array<{ runs: Array<{ program_id: string; written_views: string[] }> }> };
  const agentTaskView = store.getView(body.result.written_views[0]);
  const cascadedViewIds = body.cascade_processing.flatMap(item => item.runs.flatMap(run => run.written_views));
  const projectView = cascadedViewIds.map(id => store.getView(id)).find(view => view?.view_type === "project.current_context");
  const researchBrief = cascadedViewIds.map(id => store.getView(id)).find(view => view?.view_type === "brief.research");

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.ok(agentTaskView);
  assert.equal(agentTaskView.view_type, "analysis.http_agent_task_cascade");
  assert.ok(projectView);
  assert.deepEqual(projectView.source_views, [agentTaskView.id]);
  assert.equal(projectView.content?.source_view_type, "analysis.http_agent_task_cascade");
  assert.ok(researchBrief);
  assert.deepEqual(researchBrief.source_views, [agentTaskView.id]);
  assert.equal(researchBrief.content?.source_view_type, "analysis.http_agent_task_cascade");
}));

test("POST /agent-tasks cascade with plugin_id keeps cascaded Program Context Packs policy-scoped", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-agent-task-cascade-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "agent-plugin"), { recursive: true });
	    writeFileSync(join(dir, "plugins", "agent-plugin", "plugin.json"), JSON.stringify({
	      id: "agent-plugin",
	      name: "Agent Plugin",
	      view_types_produced: ["analysis.plugin_agent_task_cascade"],
	      permissions: {
	        allowed_sources: ["browser"],
	        allowed_schemas: ["observation.browser_ambient_requested"],
	        max_privacy_level: "private",
	        allow_external_llm: true,
	        allow_write_views: true,
	      },
	    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const projectPath = "/Users/junjie/info";
    const allowed = store.insertRecord({
      id: "record:http-agent-task-cascade-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { domain: "github.com", repo: "example/repo", project_path: projectPath },
      content: {
        title: "Allowed cascade context",
        url: "https://github.com/example/repo",
        text: "Allowed cascade context should be available to plugin-scoped Project Ambient.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-agent-task-cascade-plugin-denied-llm",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { domain: "github.com", repo: "example/repo", project_path: projectPath },
      content: {
        title: "Denied cascade context",
        url: "https://github.com/example/secret",
        text: "DENIED CASCADE CONTEXT SHOULD NOT LEAK",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertRecord({
      id: "record:http-agent-task-cascade-plugin-denied-source",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git", connector: "git" },
      scope: { project_path: projectPath },
      content: {
        title: "Denied git context",
        text: "DENIED GIT CASCADE CONTEXT SHOULD NOT LEAK",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/agent-tasks?plugin_id=agent-plugin&cascade_views=true", {
      method: "POST",
      body: {
        record_id: allowed.id,
        autonomy: "suggest",
        task: {
          runtime: "local_mock",
          goal: "Analyze allowed context and cascade into project context.",
          output_contract: {
            view_type: "analysis.plugin_agent_task_cascade",
            title: "Plugin cascade AgentTask",
          },
        },
      },
    });
    const body = response.body as { ok: boolean; cascade_processing: Array<{ runs: Array<{ written_views: string[] }> }> };
    const cascadedViewIds = body.cascade_processing.flatMap(item => item.runs.flatMap(run => run.written_views));
    const projectView = cascadedViewIds.map(id => store.getView(id)).find(view => view?.view_type === "project.current_context");
    const serialized = JSON.stringify(projectView);

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.ok(projectView);
    assert.ok(projectView.source_records?.includes(allowed.id));
    assert.ok(!projectView.source_records?.includes("record:http-agent-task-cascade-plugin-denied-llm"));
    assert.ok(!projectView.source_records?.includes("record:http-agent-task-cascade-plugin-denied-source"));
    assert.doesNotMatch(serialized, /DENIED CASCADE CONTEXT/);
    assert.doesNotMatch(serialized, /DENIED GIT CASCADE CONTEXT/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /agent-tasks supports claude_code dry_run preview without writing Views", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-http-dry-run";
  try {
    const record = store.insertRecord({
      id: "record:http-agent-task-claude-dry-run",
      schema: { name: "observation.github.issue", version: 1 },
      source: { type: "github", connector: "issues" },
      content: { title: "Issue #10", text: "Preview local Claude Code task without execution." },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const supportingView = store.upsertView({
      id: "view:http-agent-task-claude-dry-run-context",
      view_type: "brief.research",
      title: "Supporting brief",
      summary: "Validated supporting context for the dry-run prompt.",
      source_records: [record.id],
      content: { analysis: "Supporting analysis." },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/agent-tasks", {
      method: "POST",
      body: {
        record_id: record.id,
        autonomy: "suggest",
        dry_run: true,
        task: {
          runtime: "claude_code",
          goal: "Preview this Claude Code task.",
          context_pack: {
            markdown: "# Context Broker Pack\nHTTP dry run context",
            sources: [
              { id: record.id, kind: "record", uri: "https://client.example/forged-http-source", title: "CLIENT SUPPLIED HTTP SOURCE SHOULD NOT PASS" },
              { id: supportingView.id, kind: "view", uri: "https://client.example/forged-http-view" },
              { id: "missing-http-claude-prompt-source", kind: "record", uri: "context://records/missing-http-claude-prompt-source" },
            ],
          },
          constraints: { no_file_edits: true },
          output_contract: {
            view_type: "analysis.http_claude_dry_run",
            title: "HTTP Claude dry run",
          },
        },
      },
    });
    const body = response.body as { ok: boolean; result: { written_views: string[]; diagnostics: Record<string, unknown> } };

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.deepEqual(body.result.written_views, []);
    assert.equal(body.result.diagnostics.runtime, "claude_code");
    assert.equal(body.result.diagnostics.dry_run, true);
    assert.match(String(body.result.diagnostics.prompt_preview), /Preview this Claude Code task/);
    assert.match(String(body.result.diagnostics.prompt_preview), /Do not return next_actions/);
    assert.deepEqual(body.result.diagnostics.tool_policy, {
      tools: "default",
      permission_mode: "dangerously-skip-permissions",
      allowed_tools: [],
      disallowed_tools: [],
      reason: "local experiment trusts Claude Code as the external agent runtime with full tool permissions; task prompt still carries behavioral constraints",
    });
    assert.match(String(body.result.diagnostics.prompt_preview), new RegExp(`context://records/${record.id}`));
    assert.match(String(body.result.diagnostics.prompt_preview), new RegExp(`context://views/${supportingView.id}`));
    assert.doesNotMatch(String(body.result.diagnostics.prompt_preview), /CLIENT SUPPLIED HTTP SOURCE/);
    assert.doesNotMatch(String(body.result.diagnostics.prompt_preview), /client\.example\/forged-http/);
    assert.doesNotMatch(String(body.result.diagnostics.prompt_preview), /missing-http-claude-prompt-source/);
    assert.equal(store.listViews({ view_types: ["analysis.http_claude_dry_run"] }).length, 0);
    assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
  }
}));

test("POST /agent-tasks defaults omitted runtime to local Claude Code adapter", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const oldDefaultRuntime = process.env.AGENT_TASK_DEFAULT_RUNTIME;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-default-runtime-dry-run";
  delete process.env.AGENT_TASK_DEFAULT_RUNTIME;
  try {
    const record = store.insertRecord({
      id: "record:http-agent-task-default-claude",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "Current page", text: "Default AgentTask runtime should use local Claude Code during experiments." },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/agent-tasks", {
      method: "POST",
      body: {
        record_id: record.id,
        dry_run: true,
        task: {
          goal: "Analyze this browser observation through the default local agent runtime.",
          output_contract: {
            view_type: "analysis.http_default_agent_task_runtime",
            title: "HTTP default AgentTask runtime",
          },
        },
      },
    });
    const body = response.body as { ok: boolean; result: { written_views: string[]; diagnostics: Record<string, unknown> } };

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.deepEqual(body.result.written_views, []);
    assert.equal(body.result.diagnostics.runtime, "claude_code");
    assert.equal(body.result.diagnostics.dry_run, true);
    assert.match(String(body.result.diagnostics.prompt_preview), /"runtime": "claude_code"/);
    assert.deepEqual(body.result.diagnostics.tool_policy, {
      tools: "default",
      permission_mode: "dangerously-skip-permissions",
      allowed_tools: [],
      disallowed_tools: [],
      reason: "local experiment trusts Claude Code as the external agent runtime with full tool permissions; task prompt still carries behavioral constraints",
    });
    assert.equal(store.listViews({ view_types: ["analysis.http_default_agent_task_runtime"] }).length, 0);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    if (oldDefaultRuntime === undefined) delete process.env.AGENT_TASK_DEFAULT_RUNTIME;
    else process.env.AGENT_TASK_DEFAULT_RUNTIME = oldDefaultRuntime;
  }
}));

test("POST /agent-tasks claude_code denies execution when source privacy disallows external LLM use", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-should-not-be-called-for-privacy-denial";
  try {
    const record = store.insertRecord({
      id: "record:http-agent-task-claude-privacy-denied",
      schema: { name: "observation.github.issue", version: 1 },
      source: { type: "github", connector: "issues" },
      content: { title: "Private issue", text: "This source must not be sent to Claude Code." },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/agent-tasks", {
      method: "POST",
      body: {
        record_id: record.id,
        autonomy: "suggest",
        task: {
          runtime: "claude_code",
          goal: "Analyze only if privacy allows external LLM use.",
          context_pack: { markdown: "# Context Broker Pack\nHTTP privacy-denied context" },
          output_contract: {
            view_type: "analysis.http_claude_privacy_denied",
            title: "HTTP Claude privacy denied",
          },
        },
      },
    });
    const body = response.body as { ok: boolean; result: { ok: boolean; reason: string; written_views: string[]; diagnostics: Record<string, unknown> } };

    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.result.ok, false);
    assert.match(body.result.reason, /privacy denied/i);
    assert.equal(body.result.diagnostics.policy, "privacy.external_llm");
    assert.deepEqual(body.result.written_views, []);
    assert.equal(store.listViews({ view_types: ["analysis.http_claude_privacy_denied"] }).length, 0);
    assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
  }
}));

test("POST /agent-tasks claude_code missing binary fails without writing Views", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-http-agent-task";
  try {
    const record = store.insertRecord({
      id: "record:http-agent-task-claude-missing-bin",
      schema: { name: "observation.github.issue", version: 1 },
      source: { type: "github", connector: "issues" },
      content: { title: "Issue #11", text: "Fail cleanly when local Claude Code is unavailable." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/agent-tasks", {
      method: "POST",
      body: {
        record_id: record.id,
        autonomy: "suggest",
        task: {
          runtime: "claude_code",
          goal: "Run this through local Claude Code.",
          context_pack: { markdown: "# Context Broker Pack\nHTTP missing binary context" },
          output_contract: {
            view_type: "analysis.http_claude_missing_bin",
            title: "HTTP Claude missing binary",
          },
        },
      },
    });
    const body = response.body as { ok: boolean; result: { ok: boolean; reason: string; written_views: string[]; diagnostics: Record<string, unknown> } };

    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.result.ok, false);
    assert.match(body.result.reason, /Claude Code agent task failed/i);
    assert.deepEqual(body.result.written_views, []);
    assert.equal(body.result.diagnostics.runtime, "claude_code");
    assert.equal(store.listViews({ view_types: ["analysis.http_claude_missing_bin"] }).length, 0);

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



test("POST /timeline/observations/compile with unknown plugin_id does not compile unscoped evidence", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-timeline-unknown-plugin",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden timeline source", text: "UNKNOWN TIMELINE PLUGIN SHOULD NOT SEE THIS RECORD" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/timeline/observations/compile?plugin_id=missing-plugin", {
    method: "POST",
    body: { limit: 10, write: false },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN TIMELINE PLUGIN SHOULD NOT SEE/);
}));

test("POST /timeline/observations/compile ignores newer legacy Records before limiting", async () => withStore(async (store) => {
  const visible = store.insertRecord({
    id: "record:http-timeline-legacy-starvation-visible",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Visible timeline source after legacy filtering" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.insertRecord({
    id: "record:http-timeline-legacy-starvation-newer",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "NEWER LEGACY TIMELINE SOURCE SHOULD NOT STARVE RAW OBSERVATION" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const response = await request(store, "/timeline/observations/compile", {
    method: "POST",
    body: { minutes: 60, limit: 1, write: false },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.records_used, 1);
  assert.deepEqual(response.body.view.source_records, [visible.id]);
  assert.doesNotMatch(JSON.stringify(response.body.view), /NEWER LEGACY TIMELINE SOURCE/);
}));

test("POST /timeline/observations/compile with plugin_id filters source records", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-timeline-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "timeline-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "timeline-client", "plugin.json"), JSON.stringify({
      id: "timeline-client",
      name: "Timeline Client",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-timeline-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "Allowed timeline source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-timeline-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "DENIED TIMELINE SOURCE SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const response = await request(store, "/timeline/observations/compile?plugin_id=timeline-client", {
      method: "POST",
      body: { minutes: 60, limit: 20, write: true },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.plugin_id, "timeline-client");
    assert.equal(response.body.plugin_loaded, true);
    assert.equal(response.body.records_used, 1);
    assert.deepEqual(response.body.view.source_records, ["record:http-timeline-plugin-allowed"]);
    assert.equal(response.body.view.scope.plugin_id, "timeline-client");
    assert.doesNotMatch(JSON.stringify(response.body.view), /DENIED TIMELINE SOURCE/);

    const event = store.listRuntimeEvents({ event_type: "timeline_view_compiled", plugin_id: "timeline-client", limit: 1 })[0];
    assert.ok(event);
    assert.deepEqual(event.related_records, ["record:http-timeline-plugin-allowed"]);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /timeline/observations/compile with plugin_id does not let hidden records starve visible timeline evidence", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-timeline-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "timeline-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "timeline-reader", "plugin.json"), JSON.stringify({
      id: "timeline-reader",
      name: "Timeline Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-timeline-starvation-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "Visible timeline source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertRecord({
        id: `record:http-timeline-starvation-hidden-${index}`,
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser", connector: "chrome-extension" },
        content: { title: `HIDDEN TIMELINE SOURCE ${index}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
    }

    const response = await request(store, "/timeline/observations/compile?plugin_id=timeline-reader", {
      method: "POST",
      body: { minutes: 60, limit: 5, write: true },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.records_used, 1);
    assert.deepEqual(response.body.view.source_records, ["record:http-timeline-starvation-visible"]);
    assert.doesNotMatch(JSON.stringify(response.body.view), /HIDDEN TIMELINE/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /timeline/activity/compile with plugin_id filters records and events", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-activity-timeline-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "activity-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "activity-client", "plugin.json"), JSON.stringify({
      id: "activity-client",
      name: "Activity Client",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_event_types: ["timeline_view_compiled"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-activity-plugin-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "Allowed activity source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-activity-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "DENIED ACTIVITY SOURCE SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.appendRuntimeEvent({
      event_type: "timeline_view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "runtime",
      subject_id: "allowed",
      related_records: ["record:http-activity-plugin-allowed"],
      payload: { title: "Allowed activity event" },
    });
    store.appendRuntimeEvent({
      event_type: "timeline_view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "runtime",
      subject_id: "denied",
      related_records: ["record:http-activity-plugin-denied"],
      payload: { title: "DENIED ACTIVITY EVENT SHOULD NOT LEAK" },
    });

    const response = await request(store, "/timeline/activity/compile?plugin_id=activity-client", {
      method: "POST",
      body: { minutes: 60, limit: 20, event_limit: 20, write: true, include_runtime_events: true },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.plugin_id, "activity-client");
    assert.equal(response.body.plugin_loaded, true);
    assert.equal(response.body.records_used, 1);
    assert.equal(response.body.events_used, 1);
    assert.deepEqual(response.body.view.source_records, ["record:http-activity-plugin-allowed"]);
    assert.equal(response.body.view.scope.plugin_id, "activity-client");
    assert.match(JSON.stringify(response.body.view), /Allowed activity source/);
    assert.match(JSON.stringify(response.body.view), /Allowed activity event/);
    assert.doesNotMatch(JSON.stringify(response.body.view), /DENIED ACTIVITY/);

    const event = store.listRuntimeEvents({ event_type: "view_compiled", plugin_id: "activity-client", limit: 1 })[0];
    assert.ok(event);
    assert.deepEqual(event.related_records, ["record:http-activity-plugin-allowed"]);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("POST /timeline/activity/compile ignores runtime events with missing related context", async () => withStore(async (store) => {
  const visible = store.appendRuntimeEvent({
    event_type: "timeline_view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "runtime",
    subject_id: "visible-activity-event",
    payload: { title: "Visible activity runtime event" },
  });
  store.appendRuntimeEvent({
    event_type: "timeline_view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "runtime",
    subject_id: "missing-record-activity-event",
    related_records: ["record:http-activity-missing-event-record"],
    payload: { title: "MISSING ACTIVITY EVENT RECORD SHOULD NOT LEAK" },
  });
  store.appendRuntimeEvent({
    event_type: "timeline_view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "runtime",
    subject_id: "missing-view-activity-event",
    related_views: ["analysis:http-activity-missing-event-view"],
    payload: { title: "MISSING ACTIVITY EVENT VIEW SHOULD NOT LEAK" },
  });

  const response = await request(store, "/timeline/activity/compile", {
    method: "POST",
    body: { minutes: 60, limit: 10, event_limit: 10, write: false, include_runtime_events: true },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.events_used, 1);
  assert.match(JSON.stringify(response.body.view), new RegExp(visible.id));
  assert.match(JSON.stringify(response.body.view), /Visible activity runtime event/);
  assert.doesNotMatch(JSON.stringify(response.body.view), /MISSING ACTIVITY EVENT/);
}));

test("POST /timeline/activity/compile ignores newer legacy Records before limiting", async () => withStore(async (store) => {
  const visible = store.insertRecord({
    id: "record:http-activity-legacy-starvation-visible",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Visible activity source after legacy filtering" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.insertRecord({
    id: "record:http-activity-legacy-starvation-newer",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "NEWER LEGACY ACTIVITY SOURCE SHOULD NOT STARVE RAW OBSERVATION" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const response = await request(store, "/timeline/activity/compile", {
    method: "POST",
    body: { minutes: 60, limit: 1, event_limit: 0, write: false, include_runtime_events: false },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.records_used, 1);
  assert.deepEqual(response.body.view.source_records, [visible.id]);
  assert.doesNotMatch(JSON.stringify(response.body.view), /NEWER LEGACY ACTIVITY SOURCE/);
}));

test("POST /timeline/activity/compile honors fixed day ranges", async () => withStore(async (store) => {
  const now = Date.now();
  const startTime = new Date(now - 12 * 60 * 60_000).toISOString();
  const endTime = new Date(now + 60_000).toISOString();
  const early = store.insertRecord({
    id: "record:http-activity-fixed-range-early",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    time: { observed_at: new Date(now - 9 * 60 * 60_000).toISOString() },
    content: { title: "Early HTTP activity should stay visible" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const late = store.insertRecord({
    id: "record:http-activity-fixed-range-late",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    time: { observed_at: new Date(now - 5 * 60_000).toISOString() },
    content: { title: "Late HTTP activity should stay visible" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const response = await request(store, "/timeline/activity/compile", {
    method: "POST",
    body: {
      minutes: 15,
      start_time: startTime,
      end_time: endTime,
      limit: 20,
      event_limit: 0,
      write: true,
      include_runtime_events: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.records_used, 2);
  assert.deepEqual(response.body.view.source_records.sort(), [early.id, late.id].sort());
  assert.match(response.body.view.id, /^view:timeline:activity:day:\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(response.body.view.scope.time_range, { start: startTime, end: endTime });
}));

test("GET /timeline/activity/watermark changes only for timeline source activity", async () => withStore(async (store) => {
  const now = Date.now();
  const startTime = new Date(now - 60_000).toISOString();
  const endTime = new Date(now + 60 * 60_000).toISOString();
  const first = store.insertRecord({
    id: "record:http-activity-watermark-first",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    time: { observed_at: new Date(now - 10 * 60_000).toISOString() },
    content: { title: "First watermark activity" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const initial = await request(store, `/timeline/activity/watermark?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.record_count, 1);
  assert.equal(initial.body.latest_record_id, first.id);

  await request(store, "/timeline/activity/compile", {
    method: "POST",
    body: {
      start_time: startTime,
      end_time: endTime,
      limit: 20,
      event_limit: 20,
      write: true,
      include_runtime_events: true,
    },
  });
  const afterCompile = await request(store, `/timeline/activity/watermark?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`);
  assert.equal(afterCompile.body.watermark, initial.body.watermark);

  const second = store.insertRecord({
    id: "record:http-activity-watermark-second",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe" },
    time: { observed_at: new Date(now - 2 * 60_000).toISOString() },
    content: { title: "Second watermark activity" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const changed = await request(store, `/timeline/activity/watermark?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`);
  assert.notEqual(changed.body.watermark, initial.body.watermark);
  assert.equal(changed.body.record_count, 1);
  assert.equal(changed.body.latest_record_id, second.id);
}));

test("POST /timeline/activity/compile with plugin_id does not let hidden records or events starve visible activity", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-activity-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "activity-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "activity-reader", "plugin.json"), JSON.stringify({
      id: "activity-reader",
      name: "Activity Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_event_types: ["timeline_view_compiled"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-activity-starvation-visible",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      content: { title: "Visible activity source" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const visibleEvent = store.appendRuntimeEvent({
      event_type: "timeline_view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "runtime",
      subject_id: "visible",
      related_records: ["record:http-activity-starvation-visible"],
      payload: { title: "Visible activity event" },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 60; index++) {
      store.insertRecord({
        id: `record:http-activity-starvation-hidden-${index}`,
        schema: { name: "observation.browser_ambient_requested", version: 1 },
        source: { type: "browser", connector: "chrome-extension" },
        content: { title: `HIDDEN ACTIVITY SOURCE ${index}` },
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
    }
    for (let index = 0; index < 25; index++) {
      store.appendRuntimeEvent({
        event_type: "timeline_view_compiled",
        actor: "system",
        status: "completed",
        subject_type: "runtime",
        subject_id: `hidden-${index}`,
        related_records: [`record:http-activity-starvation-hidden-${index}`],
        payload: { title: `HIDDEN ACTIVITY EVENT ${index}` },
      });
    }

    const response = await request(store, "/timeline/activity/compile?plugin_id=activity-reader", {
      method: "POST",
      body: { minutes: 60, limit: 5, event_limit: 5, write: true, include_runtime_events: true },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.records_used, 1);
    assert.equal(response.body.events_used, 1);
    assert.deepEqual(response.body.view.source_records, ["record:http-activity-starvation-visible"]);
    assert.match(JSON.stringify(response.body.view), /Visible activity source/);
    assert.match(JSON.stringify(response.body.view), new RegExp(visibleEvent.id));
    assert.doesNotMatch(JSON.stringify(response.body.view), /HIDDEN ACTIVITY/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /timeline/project/compile with plugin_id filters project records and work thread Views", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-project-timeline-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "project-client"), { recursive: true });
    writeFileSync(join(dir, "plugins", "project-client", "plugin.json"), JSON.stringify({
      id: "project-client",
      name: "Project Client",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-project-timeline-allowed",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { project: "info" },
      content: { title: "Allowed project source", text: "Info project visible context" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "record:http-project-timeline-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { project: "info" },
      content: { title: "DENIED PROJECT SOURCE SHOULD NOT LEAK", text: "Info project hidden context" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "work-thread:http-project-timeline-allowed",
      view_type: "work_thread",
      title: "Allowed work thread",
      status: "candidate",
      source_records: ["record:http-project-timeline-allowed"],
      scope: { project: "info" },
      content: {
        current_status: { project: "info" },
        active_thread: { thread_id: "allowed-thread" },
        next_actions: ["Use visible evidence"],
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "work-thread:http-project-timeline-denied",
      view_type: "work_thread",
      title: "DENIED WORK THREAD SHOULD NOT LEAK",
      status: "candidate",
      source_records: ["record:http-project-timeline-denied"],
      scope: { project: "info" },
      content: {
        current_status: { project: "info" },
        active_thread: { thread_id: "denied-thread" },
        next_actions: ["DENIED NEXT ACTION SHOULD NOT LEAK"],
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const response = await request(store, "/timeline/project/compile?plugin_id=project-client", {
      method: "POST",
      body: { project: "info", minutes: 60, limit: 20, event_limit: 20, write: true },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.plugin_id, "project-client");
    assert.equal(response.body.plugin_loaded, true);
    assert.equal(response.body.records_used, 1);
    assert.deepEqual(response.body.view.source_records, ["record:http-project-timeline-allowed"]);
    assert.equal(response.body.view.scope.plugin_id, "project-client");
    assert.ok(response.body.view.source_views.includes("work-thread:http-project-timeline-allowed"));
    assert.equal(response.body.work_threads.length, 1);
    assert.equal(response.body.work_threads[0].id, "work-thread:http-project-timeline-allowed");
    assert.match(JSON.stringify(response.body.view), /Allowed project source/);
    assert.match(JSON.stringify(response.body.view), /Allowed work thread/);
    assert.doesNotMatch(JSON.stringify(response.body.view), /DENIED/);

    const event = store.listRuntimeEvents({ event_type: "view_compiled", plugin_id: "project-client", limit: 1 })[0];
    assert.ok(event);
    assert.deepEqual(event.related_records, ["record:http-project-timeline-allowed"]);
    assert.ok(event.related_views?.includes("work-thread:http-project-timeline-allowed"));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("POST /timeline/project/compile ignores work_thread Views with invalid provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-project-valid-work-thread-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "info" },
    content: { title: "Visible project source", text: "Info visible project context" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-project-dirty-work-thread-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "other" },
    content: { title: "DIRTY WORK THREAD SOURCE SHOULD NOT LEAK", text: "Other project context" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "work-thread:http-project-valid-work-thread",
    view_type: "work_thread",
    title: "Valid work thread",
    status: "candidate",
    source_records: ["record:http-project-valid-work-thread-source"],
    scope: { project: "info" },
    content: {
      current_status: { project: "info" },
      active_thread: { thread_id: "valid-thread" },
      next_actions: ["Use valid work thread"],
    },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "work-thread:http-project-missing-work-thread",
    view_type: "work_thread",
    title: "MISSING WORK THREAD SHOULD NOT LEAK",
    status: "candidate",
    source_records: ["record:http-project-missing-work-thread-source"],
    scope: { project: "info" },
    content: {
      current_status: { project: "info" },
      active_thread: { thread_id: "missing-thread" },
      next_actions: ["MISSING WORK THREAD ACTION SHOULD NOT LEAK"],
    },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "work-thread:http-project-dirty-work-thread",
    view_type: "work_thread",
    title: "DIRTY WORK THREAD SHOULD NOT LEAK",
    status: "candidate",
    source_records: ["record:http-project-dirty-work-thread-source"],
    scope: { project: "info" },
    content: {
      current_status: { project: "info" },
      active_thread: { thread_id: "dirty-thread" },
      next_actions: ["DIRTY WORK THREAD ACTION SHOULD NOT LEAK"],
    },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, "/timeline/project/compile", {
    method: "POST",
    body: { project: "info", minutes: 60, limit: 20, event_limit: 0, write: false },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.work_threads.map((thread: { id: string }) => thread.id), ["work-thread:http-project-valid-work-thread"]);
  assert.ok(response.body.view.source_views.includes("work-thread:http-project-valid-work-thread"));
  assert.ok(!response.body.view.source_views.includes("work-thread:http-project-missing-work-thread"));
  assert.ok(!response.body.view.source_views.includes("work-thread:http-project-dirty-work-thread"));
  assert.match(JSON.stringify(response.body.view), /Valid work thread/);
  assert.doesNotMatch(JSON.stringify(response.body.view), /MISSING WORK THREAD/);
  assert.doesNotMatch(JSON.stringify(response.body.view), /DIRTY WORK THREAD/);
}));

test("POST /timeline/project/compile ignores newer legacy Records before limiting", async () => withStore(async (store) => {
  const visible = store.insertRecord({
    id: "record:http-project-timeline-legacy-starvation-visible",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "info" },
    content: { title: "Visible project source after legacy filtering", text: "Info visible project context" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 2; index++) {
    store.insertRecord({
      id: `record:http-project-timeline-legacy-starvation-newer-${index}`,
      schema: { name: "derived.project_memory", version: 1 },
      source: { type: "plugin", connector: "legacy" },
      scope: { project: "info" },
      content: { title: `NEWER LEGACY PROJECT SOURCE SHOULD NOT STARVE RAW OBSERVATION ${index}` },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
  }

  const response = await request(store, "/timeline/project/compile", {
    method: "POST",
    body: { project: "info", minutes: 60, limit: 1, event_limit: 0, write: false, include_runtime_events: false },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.records_used, 1);
  assert.deepEqual(response.body.view.source_records, [visible.id]);
  assert.doesNotMatch(JSON.stringify(response.body.view), /NEWER LEGACY PROJECT SOURCE/);
}));

test("GET /context/views/:id returns a single View for Applications", async () => withStore(async (store) => {
  store.upsertView({
    id: "project:http-single-view",
    view_type: "project.current_context",
    title: "HTTP single project context",
    content: { analysis: "single view lookup" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("project:http-single-view")}`);
  const body = response.body as { ok: boolean; view: { id: string; view_type: string } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.view.id, "project:http-single-view");
  assert.equal(body.view.view_type, "project.current_context");
}));

test("GET /context/views/:id with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-single-view-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-single-view-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied source", text: "DENIED SINGLE VIEW CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:http-single-view-plugin-denied",
      view_type: "analysis.browser_page",
      title: "Denied browser analysis",
      source_records: ["record:http-single-view-plugin-denied"],
      content: { analysis: "DENIED SINGLE VIEW ANALYSIS SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const denied = await request(store, `/context/views/${encodeURIComponent("analysis:http-single-view-plugin-denied")}?plugin_id=external-agent`);
    const unscoped = await request(store, `/context/views/${encodeURIComponent("analysis:http-single-view-plugin-denied")}`);

    assert.equal(denied.status, 404);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.error, "view not found");
    assert.equal(denied.body.plugin_id, "external-agent");
    assert.equal(denied.body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(denied.body), /DENIED SINGLE VIEW/);

    assert.equal(unscoped.status, 200);
    assert.match(JSON.stringify(unscoped.body), /DENIED SINGLE VIEW ANALYSIS SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});



test("GET /context/views/:id with unknown plugin_id does not fall back to unscoped View", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:http-single-unknown-plugin-view",
    view_type: "analysis.browser_page",
    title: "Hidden single analysis",
    content: { analysis: "UNKNOWN SINGLE PLUGIN SHOULD NOT SEE THIS VIEW" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("analysis:http-single-unknown-plugin-view")}?plugin_id=missing-plugin`);

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN SINGLE PLUGIN SHOULD NOT SEE/);
}));

test("GET /context/views/:id excludes Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-single-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting single source", text: "CONFLICTING SINGLE SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-single-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting single View",
    source_records: ["record:http-single-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING SINGLE VIEW SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("analysis:http-single-scope-conflict")}`);

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view not found");
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING SINGLE/);
}));

test("GET /context/views/:id returns 404 for missing View", async () => withStore(async (store) => {
  const response = await request(store, `/context/views/${encodeURIComponent("missing:view")}`);
  const body = response.body as { ok: boolean; error: string };

  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, "view not found");
}));

test("GET /context/views/:id/provenance exposes source chain for Applications", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-provenance",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "HTTP provenance source" },
  });
  store.upsertView({
    id: "analysis:http-provenance",
    view_type: "analysis.browser_page",
    source_records: ["record:http-provenance"],
    content: { analysis: "source analysis" },
  });
  store.upsertView({
    id: "project:http-provenance",
    view_type: "project.current_context",
    source_views: ["analysis:http-provenance"],
    content: { analysis: "project analysis" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("project:http-provenance")}/provenance`);
  const body = response.body as { ok: boolean; views: Array<{ id: string }>; records: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["project:http-provenance", "analysis:http-provenance"]);
  assert.deepEqual(body.records.map(record => record.id), ["record:http-provenance"]);
}));

test("GET /context/views/:id/provenance hides legacy non-observation Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-provenance-legacy-derived",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy derived", text: "LEGACY PROVENANCE RECORD SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:http-provenance-observation",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Observed source", text: "Observed provenance source." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-provenance-legacy-source",
    view_type: "analysis.browser_page",
    source_records: ["record:http-provenance-legacy-derived", "record:http-provenance-observation"],
    content: { analysis: "View should remain visible while legacy source Record is hidden." },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("analysis:http-provenance-legacy-source")}/provenance`);
  const body = response.body as { ok: boolean; views: Array<{ id: string }>; records: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.views.map(view => view.id), ["analysis:http-provenance-legacy-source"]);
  assert.deepEqual(body.records.map(record => record.id), ["record:http-provenance-observation"]);
  assert.doesNotMatch(JSON.stringify(body), /LEGACY PROVENANCE RECORD SHOULD NOT LEAK/);
}));

test("GET /context/views/:id/provenance excludes root Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-provenance-scope-conflict-source",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Conflicting provenance source", text: "CONFLICTING PROVENANCE SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-provenance-scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting provenance View",
    source_records: ["record:http-provenance-scope-conflict-source"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING PROVENANCE VIEW SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("analysis:http-provenance-scope-conflict")}/provenance`);

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "view not found");
  assert.doesNotMatch(JSON.stringify(response.body), /CONFLICTING PROVENANCE/);
}));



test("GET /context/views/:id/provenance with unknown plugin_id does not fall back to unscoped provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:http-provenance-unknown-plugin",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden provenance", text: "UNKNOWN PROVENANCE PLUGIN SHOULD NOT SEE THIS RECORD" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:http-provenance-unknown-plugin",
    view_type: "analysis.browser_page",
    source_records: ["record:http-provenance-unknown-plugin"],
    content: { analysis: "UNKNOWN PROVENANCE PLUGIN SHOULD NOT SEE THIS VIEW" },
    privacy: { level: "private", retention: "normal" },
  });

  const response = await request(store, `/context/views/${encodeURIComponent("analysis:http-provenance-unknown-plugin")}/provenance?plugin_id=missing-plugin`);

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.plugin_loaded, false);
  assert.match(response.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /UNKNOWN PROVENANCE PLUGIN SHOULD NOT SEE/);
}));
test("GET /context/views/:id/provenance with plugin_id applies plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-http-provenance-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "record:http-provenance-plugin-denied",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Denied source", text: "DENIED PROVENANCE CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:http-provenance-plugin-denied",
      view_type: "analysis.browser_page",
      title: "Denied browser analysis",
      source_records: ["record:http-provenance-plugin-denied"],
      content: { analysis: "DENIED PROVENANCE ANALYSIS SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const denied = await request(store, `/context/views/${encodeURIComponent("analysis:http-provenance-plugin-denied")}/provenance?plugin_id=external-agent`);
    const unscoped = await request(store, `/context/views/${encodeURIComponent("analysis:http-provenance-plugin-denied")}/provenance`);

    assert.equal(denied.status, 404);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.error, "view not found");
    assert.equal(denied.body.plugin_id, "external-agent");
    assert.equal(denied.body.plugin_loaded, true);
    assert.doesNotMatch(JSON.stringify(denied.body), /DENIED PROVENANCE/);

    assert.equal(unscoped.status, 200);
    assert.match(JSON.stringify(unscoped.body), /DENIED PROVENANCE ANALYSIS SHOULD NOT LEAK/);
    assert.match(JSON.stringify(unscoped.body), /DENIED PROVENANCE CONTEXT SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeChatAcpAgentSource(): string {
  return `
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let connection;
const agent = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { close: {} }
      },
      agentInfo: { name: "fake-chat-acp-agent", version: "0.0.1" },
      authMethods: []
    };
  },
  async newSession() {
    return { sessionId: "sess_chat_fake" };
  },
  async prompt(params) {
    const promptText = params.prompt.map(block => block.type === "text" ? block.text : "").join("\\n");
    if (/"output_contract"\s*:|AGENT TASK:|Return only JSON matching/.test(promptText)) {
      throw new Error("chat prompt leaked AgentTask contract");
    }
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ACP chat saw page context without AgentTask JSON." }
      }
    });
    return { stopReason: "end_turn" };
  },
  async cancel() {},
  async closeSession() { return {}; },
  async authenticate() {}
};

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
connection = new AgentSideConnection(() => agent, ndJsonStream(input, output));
await connection.closed;
`;
}

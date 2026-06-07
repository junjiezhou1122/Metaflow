import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContextPack } from "@info/core";
import { ContextStore } from "@info/core";
import type { ContextRecord, ContextView } from "@info/core";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-broker-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Context pack circulates analysis Views with provenance and rendered content", async () => withStore(async (store) => {
  const record: ContextRecord = {
    id: "obs-browser-1",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "github.com" },
    time: { observed_at: "2026-05-24T10:00:00.000Z" },
    content: { title: "example/repo", url: "https://github.com/example/repo", text: "Repository page text" },
    privacy: { level: "private", retention: "normal" },
  };
  store.insertRecord(record);

  const view: ContextView = {
    id: "analysis:browser-page:test",
    view_type: "analysis.browser_page",
    title: "Browser analysis: example/repo",
    summary: "Repo overview summary",
    source_records: ["obs-browser-1"],
    compiler: { id: "program.browser_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Reusable browser page analysis.",
    scope: { app: "chrome", domain: "github.com", plugin_id: "program.browser_ambient" },
    content: {
      analysis: "This repo appears to be a local-first ambient runtime reference.",
      key_points: ["GitHub repository", "Local-first context pattern"],
      tags: ["github", "ambient", "runtime"],
    },
    confidence: 0.88,
    privacy: { level: "private", retention: "normal" },
  };
  store.upsertView(view);

  const pack = buildContextPack({
    goal: "Use recent browser analysis as project context",
    include_views: true,
    include_records: true,
    view_types: ["analysis.browser_page"],
    scope: { domain: "github.com" },
    limit: 6,
  }, store);

  assert.deepEqual(pack.views.map(item => item.id), ["analysis:browser-page:test"]);
  assert.deepEqual(pack.records.map(item => item.id), ["obs-browser-1"]);
  assert.match(pack.markdown, /#### Analysis/);
  assert.match(pack.markdown, /local-first ambient runtime reference/);
  assert.match(pack.markdown, /#### Key points/);
  assert.match(pack.markdown, /Local-first context pattern/);
  assert.match(pack.markdown, /#### Tags/);
  assert.match(pack.markdown, /ambient/);
  assert.doesNotMatch(pack.markdown, /Next actions/);
  assert.ok(pack.sources.some(source => source.kind === "view" && source.id === "analysis:browser-page:test"));
  assert.ok(pack.sources.some(source => source.kind === "record" && source.id === "obs-browser-1"));
}));

test("Context pack with unknown plugin_id does not fall back to unscoped context", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-unknown-plugin-should-not-leak",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden observation", text: "UNKNOWN PLUGIN SHOULD NOT SEE THIS OBSERVATION" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:unknown-plugin-should-not-leak",
    view_type: "analysis.browser_page",
    title: "Hidden analysis",
    content: { analysis: "UNKNOWN PLUGIN SHOULD NOT SEE THIS VIEW" },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    plugin_id: "missing-plugin",
    include_records: true,
    include_views: true,
    goal: "anything",
    limit: 8,
  }, store);

  assert.deepEqual(pack.records, []);
  assert.deepEqual(pack.views, []);
  assert.equal(pack.diagnostics.plugin_loaded, false);
  assert.match(String(pack.diagnostics.error), /plugin not found/);
  assert.doesNotMatch(pack.markdown, /UNKNOWN PLUGIN SHOULD NOT SEE/);
}));

test("Context pack excludes legacy non-observation Records while keeping derived Views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "legacy-derived-record",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { title: "Legacy derived record", text: "LEGACY DERIVED RECORD SHOULD NOT BE PACKED" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "observation-source-record",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Observed browser page", text: "Observed factual browser page should be packed." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:derived-view",
    view_type: "analysis.browser_page",
    title: "Derived browser analysis View",
    summary: "Derived Views are the right place for intelligence.",
    source_records: ["observation-source-record"],
    content: { analysis: "DERIVED VIEW SHOULD BE PACKED" },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    query: "derived observed browser",
    include_records: true,
    include_views: true,
    limit: 6,
  }, store);

  assert.ok(pack.records.some(record => record.id === "observation-source-record"));
  assert.ok(!pack.records.some(record => record.id === "legacy-derived-record"));
  assert.ok(pack.views.some(view => view.id === "analysis:derived-view"));
  assert.match(pack.markdown, /DERIVED VIEW SHOULD BE PACKED/);
  assert.doesNotMatch(pack.markdown, /LEGACY DERIVED RECORD SHOULD NOT BE PACKED/);
  assert.ok(pack.sources.some(source => source.kind === "record" && source.id === "observation-source-record"));
  assert.ok(!pack.sources.some(source => source.kind === "record" && source.id === "legacy-derived-record"));
}));

test("Context pack excludes Views whose scope conflicts with provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-scope-clean",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { title: "Issue #1", text: "Clean repo evidence should remain available." },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "obs-scope-conflict",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: { title: "Issue #2", text: "CONFLICTING VIEW SOURCE SHOULD NOT CIRCULATE" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:scope-clean",
    view_type: "analysis.github_issue",
    title: "Clean scoped View",
    source_records: ["obs-scope-clean"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "Clean scoped View should circulate." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:scope-conflict",
    view_type: "analysis.github_issue",
    title: "Conflicting scoped View",
    source_records: ["obs-scope-conflict"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: { analysis: "CONFLICTING VIEW SHOULD NOT CIRCULATE" },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    include_records: false,
    include_views: true,
    view_types: ["analysis.github_issue"],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    limit: 6,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:scope-clean"]);
  assert.deepEqual(pack.records, []);
  assert.match(pack.markdown, /Clean scoped View should circulate/);
  assert.doesNotMatch(pack.markdown, /CONFLICTING VIEW/);
}));

test("Context pack renders standardized AgentTask output fields", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:agent-output-render",
    view_type: "analysis.browser_agent_task",
    title: "Browser AgentTask analysis",
    summary: "AgentTask summary",
    compiler: { id: "capability.agent_task.submit", version: "0.1.0", mode: "hybrid" },
    content: {
      agent_task: { runtime: "local_mock", goal: "Analyze browser page" },
      agent_output: {
        analysis: "Standardized AgentTask analysis should render in broker markdown.",
        key_points: ["Agent output key point", "Reusable by context packs"],
      },
    },
    confidence: 0.75,
  });

  const pack = buildContextPack({
    goal: "Use agent task output as context",
    include_views: true,
    include_records: false,
    view_types: ["analysis.browser_agent_task"],
    limit: 3,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:agent-output-render"]);
  assert.match(pack.markdown, /#### Analysis/);
  assert.match(pack.markdown, /Standardized AgentTask analysis should render/);
  assert.match(pack.markdown, /#### Key points/);
  assert.match(pack.markdown, /Agent output key point/);
}));

test("Context pack renders project related_records evidence from View content", async () => withStore(async (store) => {
  store.upsertView({
    id: "project:current-context:evidence-render",
    view_type: "project.current_context",
    title: "Project context: evidence render",
    content: {
      analysis: "Project context with structured evidence.",
      related_records: [
        {
          id: "git-diff-render",
          schema: "observation.git.diff",
          source: "git",
          title: "Git diff for project ambient",
          path: "/Users/junjie/info/src/programs/builtins/project-ambient.ts",
        },
        {
          id: "browser-render",
          schema: "observation.browser_ambient_requested",
          source: "browser",
          title: "example/repo",
          url: "https://github.com/example/repo",
        },
      ],
    },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    include_views: true,
    include_records: false,
    view_types: ["project.current_context"],
    limit: 4,
  }, store);

  assert.match(pack.markdown, /#### Related records/);
  assert.match(pack.markdown, /observation\.git\.diff/);
  assert.match(pack.markdown, /Git diff for project ambient/);
  assert.match(pack.markdown, /observation\.browser_ambient_requested/);
  assert.match(pack.markdown, /example\/repo/);
}));

test("Context pack can query Views by type prefix for agent attention", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:prefix-browser",
    view_type: "analysis.browser_page",
    title: "Browser analysis prefix",
    content: { analysis: "Browser analysis included by prefix." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:prefix-repo",
    view_type: "analysis.repo",
    title: "Repo analysis prefix",
    content: { analysis: "Repo analysis included by prefix." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "project:prefix-context",
    view_type: "project.current_context",
    title: "Project context prefix",
    content: { analysis: "Project context should not match analysis prefix." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    include_views: true,
    include_records: false,
    view_type_prefix: "analysis.",
    limit: 6,
  }, store);

  assert.deepEqual(
    new Set(pack.views.map(view => view.id)),
    new Set(["analysis:prefix-browser", "analysis:prefix-repo"]),
  );
  assert.match(pack.markdown, /Browser analysis included by prefix/);
  assert.match(pack.markdown, /Repo analysis included by prefix/);
  assert.doesNotMatch(pack.markdown, /Project context should not match analysis prefix/);
}));

test("Context pack query filters Views by keyword content", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:keyword-match",
    view_type: "analysis.browser_page",
    title: "Rust ownership article",
    summary: "Explains borrow checker and lifetimes.",
    content: { agent_output: { analysis: "Deep notes about Rust borrow checker behavior." } },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:keyword-miss",
    view_type: "analysis.browser_page",
    title: "TypeScript runtime article",
    summary: "Explains event loops.",
    content: { agent_output: { analysis: "Deep notes about TypeScript runtime behavior." } },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    query: "borrow checker",
    include_views: true,
    include_records: false,
    view_type_prefix: "analysis.",
    limit: 6,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:keyword-match"]);
  assert.match(pack.markdown, /borrow checker/);
  assert.doesNotMatch(pack.markdown, /TypeScript runtime behavior/);
}));

test("Context source mode uses scope/source filters instead of semantic goal search", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-source-mode-browser",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "github.com" },
    content: { title: "Semantic matching record", text: "agent runtime architecture" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "obs-source-mode-git",
    schema: { name: "observation.git.diff", version: 1 },
    source: { type: "git", connector: "local" },
    scope: { domain: "github.com" },
    content: { title: "Git diff", text: "diff --git a/src/programs/builtins/project-ambient.ts" },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    mode: "source",
    goal: "agent runtime architecture",
    include_views: false,
    include_records: true,
    scope: { domain: "github.com" },
    limit: 8,
  }, store);

  assert.deepEqual(new Set(pack.records.map(record => record.id)), new Set(["obs-source-mode-browser", "obs-source-mode-git"]));
}));

test("Context pack expands direct source_views so derived View chains stay inspectable", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-browser-chain",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "github.com" },
    content: { title: "example/repo", url: "https://github.com/example/repo", text: "Repository page text" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:browser-page:chain",
    view_type: "analysis.browser_page",
    title: "Browser analysis: example/repo",
    summary: "Repo overview summary",
    source_records: ["obs-browser-chain"],
    compiler: { id: "program.browser_ambient", version: "0.1.0", mode: "deterministic" },
    scope: { app: "chrome", domain: "github.com", plugin_id: "program.browser_ambient" },
    content: { analysis: "Browser page analysis in the middle of the provenance chain." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "project:current-context:chain",
    view_type: "project.current_context",
    title: "Project context: example/repo",
    summary: "Project context derived from browser analysis.",
    source_views: ["analysis:browser-page:chain"],
    compiler: { id: "program.project_ambient", version: "0.1.0", mode: "deterministic" },
    scope: { app: "chrome", domain: "github.com", plugin_id: "program.project_ambient" },
    content: { analysis: "Project-level context." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    goal: "Use project context with provenance",
    include_views: true,
    include_records: true,
    view_types: ["project.current_context"],
    scope: { domain: "github.com" },
    limit: 8,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["project:current-context:chain", "analysis:browser-page:chain"]);
  assert.deepEqual(pack.records.map(record => record.id), ["obs-browser-chain"]);
  assert.ok(pack.sources.some(source => source.kind === "view" && source.id === "analysis:browser-page:chain"));
  assert.match(pack.markdown, /Browser page analysis in the middle of the provenance chain/);
}));

test("Context pack expands nested source_views within a bounded provenance chain", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-nested-chain",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "github.com" },
    content: { title: "nested/repo", url: "https://github.com/nested/repo", text: "Repository page text" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:browser-page:nested",
    view_type: "analysis.browser_page",
    title: "Browser analysis: nested/repo",
    source_records: ["obs-nested-chain"],
    compiler: { id: "program.browser_ambient", mode: "deterministic" },
    scope: { domain: "github.com", plugin_id: "program.browser_ambient" },
    content: { analysis: "Nested raw browser analysis." },
  });
  store.upsertView({
    id: "brief:research:nested",
    view_type: "brief.research",
    title: "Research brief: nested/repo",
    source_views: ["analysis:browser-page:nested"],
    compiler: { id: "program.research_shadow", mode: "deterministic" },
    scope: { domain: "github.com", plugin_id: "program.research_shadow" },
    content: { analysis: "Research synthesis over browser analysis." },
  });
  store.upsertView({
    id: "project:current-context:nested",
    view_type: "project.current_context",
    title: "Project context: nested/repo",
    source_views: ["brief:research:nested"],
    compiler: { id: "program.project_ambient", mode: "deterministic" },
    scope: { domain: "github.com", plugin_id: "program.project_ambient" },
    content: { analysis: "Project context over research brief." },
  });

  const pack = buildContextPack({
    goal: "Use nested project context with provenance",
    include_views: true,
    include_records: true,
    view_types: ["project.current_context"],
    scope: { domain: "github.com" },
    limit: 10,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), [
    "project:current-context:nested",
    "brief:research:nested",
    "analysis:browser-page:nested",
  ]);
  assert.deepEqual(pack.records.map(record => record.id), ["obs-nested-chain"]);
  assert.match(pack.markdown, /Nested raw browser analysis/);
}));

test("Context pack ignores inactive or expired Views", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:active-view",
    view_type: "analysis.browser_page",
    title: "Active analysis",
    content: { analysis: "Active view should be included." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:archived-view",
    view_type: "analysis.browser_page",
    title: "Archived analysis",
    status: "archived",
    content: { analysis: "Archived view should not be included." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:expired-view",
    view_type: "analysis.browser_page",
    title: "Expired analysis",
    validity: { valid_until: "2026-01-01T00:00:00.000Z" },
    content: { analysis: "Expired view should not be included." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:stale-view",
    view_type: "analysis.browser_page",
    title: "Stale analysis",
    validity: { stale_after: "2026-01-01T00:00:00.000Z" },
    content: { analysis: "Stale view should not be included." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    goal: "Use active browser analysis",
    include_views: true,
    include_records: false,
    view_types: ["analysis.browser_page"],
    limit: 6,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:active-view"]);
  assert.match(pack.markdown, /Active view should be included/);
  assert.doesNotMatch(pack.markdown, /Archived view should not be included/);
  assert.doesNotMatch(pack.markdown, /Expired view should not be included/);
  assert.doesNotMatch(pack.markdown, /Stale view should not be included/);
}));

test("Context pack does not expand inactive source_views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-behind-inactive-source-view",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Inactive source", text: "RECORD BEHIND INACTIVE SOURCE VIEW SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:inactive-source",
    view_type: "analysis.browser_page",
    title: "Inactive source analysis",
    status: "archived",
    source_records: ["obs-behind-inactive-source-view"],
    content: { analysis: "Inactive source view should not be included." },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "project:active-over-inactive-source",
    view_type: "project.current_context",
    title: "Active project context",
    source_views: ["analysis:inactive-source"],
    content: { analysis: "Active high-level context." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    goal: "Use active project context",
    include_views: true,
    include_records: true,
    view_types: ["project.current_context"],
    limit: 8,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["project:active-over-inactive-source"]);
  assert.deepEqual(pack.records.map(record => record.id), []);
  assert.doesNotMatch(pack.markdown, /Inactive source view should not be included/);
  assert.doesNotMatch(pack.markdown, /RECORD BEHIND INACTIVE SOURCE VIEW SHOULD NOT LEAK/);
}));

test("Context pack can be explicitly scoped for external LLM use", async () => withStore(async (store) => {
  store.insertRecord({
    id: "external-allowed-record",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Allowed browser source", text: "ALLOWED SOURCE MAY REACH EXTERNAL LLM" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });
  store.insertRecord({
    id: "external-denied-record",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Denied browser source", text: "DENIED SOURCE MUST NOT REACH EXTERNAL LLM" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "analysis:external-denied",
    view_type: "analysis.browser_page",
    title: "Denied browser analysis",
    source_records: ["external-denied-record"],
    content: { analysis: "DENIED VIEW MUST NOT REACH EXTERNAL LLM" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "analysis:external-allowed",
    view_type: "analysis.browser_page",
    title: "Allowed browser analysis",
    source_records: ["external-allowed-record"],
    content: { analysis: "ALLOWED VIEW MAY REACH EXTERNAL LLM" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const pack = buildContextPack({
    goal: "Build external agent context",
    include_records: true,
    include_views: true,
    allow_external_llm: true,
    limit: 8,
  }, store);

  assert.deepEqual(pack.records.map(record => record.id), ["external-allowed-record"]);
  assert.deepEqual(pack.views.map(view => view.id), ["analysis:external-allowed"]);
  assert.match(pack.markdown, /ALLOWED SOURCE MAY REACH EXTERNAL LLM/);
  assert.match(pack.markdown, /ALLOWED VIEW MAY REACH EXTERNAL LLM/);
  assert.doesNotMatch(pack.markdown, /DENIED SOURCE MUST NOT REACH EXTERNAL LLM/);
  assert.doesNotMatch(pack.markdown, /DENIED VIEW MUST NOT REACH EXTERNAL LLM/);
  assert.equal(pack.diagnostics.allow_external_llm, true);
}));

test("Context pack does not leak records from source_views denied by plugin permissions", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-permission-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "limited"), { recursive: true });
    writeFileSync(join(dir, "plugins", "limited", "plugin.json"), JSON.stringify({
      id: "limited",
      name: "Limited",
      permissions: {
        allowed_view_types: ["project.current_context"],
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "allowed-record-behind-denied-view",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Browser source", text: "BROWSER RECORD BEHIND DENIED VIEW SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal" },
    });
    store.upsertView({
      id: "analysis:secret",
      view_type: "analysis.secret",
      title: "Secret analysis",
      source_records: ["allowed-record-behind-denied-view"],
      content: { analysis: "Secret middle view should not leak." },
      privacy: { level: "private", retention: "normal" },
    });
    store.upsertView({
      id: "project:allowed",
      view_type: "project.current_context",
      title: "Allowed project context",
      source_views: ["analysis:secret"],
      content: { analysis: "Allowed high-level view." },
      privacy: { level: "private", retention: "normal" },
    });

    const pack = buildContextPack({
      plugin_id: "limited",
      query: "only high level context",
      include_views: true,
      include_records: true,
      view_types: ["project.current_context"],
      limit: 8,
    }, store);

    assert.deepEqual(pack.views.map(view => view.id), ["project:allowed"]);
    assert.deepEqual(pack.records.map(record => record.id), []);
    assert.doesNotMatch(pack.markdown, /BROWSER RECORD BEHIND DENIED VIEW SHOULD NOT LEAK/);
    assert.doesNotMatch(pack.markdown, /Secret middle view should not leak/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack excludes Views whose source_views exceed plugin max privacy", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-source-view-privacy-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "public-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "public-agent", "plugin.json"), JSON.stringify({
      id: "public-agent",
      name: "Public Agent",
      permissions: {
        allowed_view_types: ["project.current_context"],
        max_privacy_level: "public",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.upsertView({
      id: "memory:secret-source-view",
      view_type: "memory.project.patterns",
      title: "Secret source memory",
      content: { analysis: "SECRET SOURCE VIEW SHOULD NOT LEAK THROUGH PROVENANCE" },
      privacy: { level: "secret", retention: "normal" },
    });
    store.upsertView({
      id: "project:public-derived-from-secret",
      view_type: "project.current_context",
      title: "Public-looking project context",
      source_views: ["memory:secret-source-view"],
      content: { analysis: "PUBLIC LOOKING DERIVED VIEW SHOULD NOT LEAK" },
      privacy: { level: "public", retention: "normal" },
    });

    const pack = buildContextPack({
      plugin_id: "public-agent",
      include_views: true,
      include_records: false,
      view_types: ["project.current_context"],
      limit: 8,
    }, store);

    assert.deepEqual(pack.views.map(view => view.id), []);
    assert.doesNotMatch(pack.markdown, /SECRET SOURCE VIEW SHOULD NOT LEAK/);
    assert.doesNotMatch(pack.markdown, /PUBLIC LOOKING DERIVED VIEW SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack excludes external-LLM-denied provenance for external agent plugins", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-external-llm-test-"));
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
      id: "external-llm-allowed-record",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Allowed source", text: "ALLOWED EXTERNAL LLM CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "external-llm-denied-record",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Denied source", text: "DENIED EXTERNAL LLM CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:external-allowed",
      view_type: "analysis.browser_page",
      title: "Allowed analysis",
      scope: { domain: "example.com" },
      source_records: ["external-llm-allowed-record"],
      content: { analysis: "Allowed derived analysis." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:external-denied",
      view_type: "analysis.browser_page",
      title: "Denied analysis",
      scope: { domain: "example.com" },
      source_records: ["external-llm-denied-record"],
      content: { analysis: "DENIED DERIVED ANALYSIS SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const pack = buildContextPack({
      plugin_id: "external-agent",
      include_views: true,
      include_records: true,
      view_types: ["analysis.browser_page"],
      scope: { domain: "example.com" },
      limit: 8,
    }, store);

    assert.deepEqual(pack.views.map(view => view.id), ["analysis:external-allowed"]);
    assert.deepEqual(pack.records.map(record => record.id), ["external-llm-allowed-record"]);
    assert.match(pack.markdown, /ALLOWED EXTERNAL LLM CONTEXT/);
    assert.doesNotMatch(pack.markdown, /DENIED EXTERNAL LLM CONTEXT SHOULD NOT LEAK/);
    assert.doesNotMatch(pack.markdown, /DENIED DERIVED ANALYSIS SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack does not use external-LLM-denied surfacing memory for external agent plugins", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-external-memory-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_view_types: ["analysis.browser_page", "analysis.repo"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.upsertView({
      id: "memory:external-denied-surfacing",
      view_type: "memory.surfacing_preference",
      title: "Show less browser analysis",
      content: {
        preference: "show_less",
        target_view_type: "analysis.browser_page",
      },
      confidence: 0.9,
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:external-repo-older",
      view_type: "analysis.repo",
      title: "Older repo analysis",
      content: { analysis: "Older repo analysis should not win without allowed surfacing memory." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    store.upsertView({
      id: "analysis:external-browser-newer",
      view_type: "analysis.browser_page",
      title: "Newer browser analysis",
      content: { analysis: "Newer browser analysis should win when denied memory is ignored." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const pack = buildContextPack({
      plugin_id: "external-agent",
      include_views: true,
      include_records: false,
      view_type_prefix: "analysis.",
      limit: 1,
    }, store);

    assert.deepEqual(pack.views.map(view => view.id), ["analysis:external-browser-newer"]);
    assert.deepEqual(pack.diagnostics.surfacing_preferences, {
      show_more_view_types: [],
      show_less_view_types: [],
      source_view_ids: [],
    });
    assert.match(pack.markdown, /Newer browser analysis should win/);
    assert.doesNotMatch(pack.markdown, /Older repo analysis should not win/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack plugin surfacing memory is not starved by hidden memory Views", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-memory-starvation-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-agent", "plugin.json"), JSON.stringify({
      id: "external-agent",
      name: "External Agent",
      permissions: {
        allowed_view_types: ["analysis.browser_page", "analysis.repo", "memory.surfacing_preference"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.upsertView({
      id: "memory:visible-show-more-repo",
      view_type: "memory.surfacing_preference",
      title: "Show more repo analysis",
      content: {
        preference: "show_more",
        target_view_type: "analysis.repo",
      },
      confidence: 0.9,
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:repo-preferred-by-visible-memory",
      view_type: "analysis.repo",
      title: "Repo analysis preferred by visible memory",
      content: { analysis: "Visible surfacing memory should raise this repo analysis." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    store.upsertView({
      id: "analysis:browser-newer-default",
      view_type: "analysis.browser_page",
      title: "Newer browser analysis default",
      content: { analysis: "Newer default browser analysis should not win." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    for (let index = 0; index < 60; index++) {
      store.upsertView({
        id: `memory:hidden-surfacing-${index}`,
        view_type: "memory.surfacing_preference",
        title: `Hidden surfacing memory ${index}`,
        content: {
          preference: "show_less",
          target_view_type: "analysis.repo",
        },
        confidence: 0.9,
        privacy: { level: "private", retention: "normal", allow_external_llm: false },
      });
    }

    const pack = buildContextPack({
      plugin_id: "external-agent",
      include_views: true,
      include_records: false,
      view_type_prefix: "analysis.",
      limit: 1,
    }, store);

    assert.deepEqual(pack.views.map(view => view.id), ["analysis:repo-preferred-by-visible-memory"]);
    assert.deepEqual(pack.diagnostics.surfacing_preferences, {
      show_more_view_types: ["analysis.repo"],
      show_less_view_types: [],
      source_view_ids: ["memory:visible-show-more-repo"],
    });
    assert.match(pack.markdown, /Visible surfacing memory should raise/);
    assert.doesNotMatch(pack.markdown, /Newer default browser analysis should not win/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack excludes external-reader-denied provenance for external reader plugins", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-external-reader-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "external-reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "external-reader", "plugin.json"), JSON.stringify({
      id: "external-reader",
      name: "External Reader",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        max_privacy_level: "private",
        allow_external_reader: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "external-reader-allowed-record",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Allowed reader source", text: "ALLOWED EXTERNAL READER CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_reader: true },
    });
    store.insertRecord({
      id: "external-reader-denied-record",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      scope: { domain: "example.com" },
      content: { title: "Denied reader source", text: "DENIED EXTERNAL READER CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_reader: false },
    });
    store.upsertView({
      id: "analysis:reader-allowed",
      view_type: "analysis.browser_page",
      title: "Allowed reader analysis",
      scope: { domain: "example.com" },
      source_records: ["external-reader-allowed-record"],
      content: { analysis: "Allowed reader derived analysis." },
      privacy: { level: "private", retention: "normal", allow_external_reader: true },
    });
    store.upsertView({
      id: "analysis:reader-denied",
      view_type: "analysis.browser_page",
      title: "Denied reader analysis",
      scope: { domain: "example.com" },
      source_records: ["external-reader-denied-record"],
      content: { analysis: "DENIED READER DERIVED ANALYSIS SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_reader: true },
    });

    const pack = buildContextPack({
      plugin_id: "external-reader",
      include_views: true,
      include_records: true,
      view_types: ["analysis.browser_page"],
      scope: { domain: "example.com" },
      limit: 8,
    }, store);

    assert.deepEqual(pack.views.map(view => view.id), ["analysis:reader-allowed"]);
    assert.deepEqual(pack.records.map(record => record.id), ["external-reader-allowed-record"]);
    assert.match(pack.markdown, /ALLOWED EXTERNAL READER CONTEXT/);
    assert.doesNotMatch(pack.markdown, /DENIED EXTERNAL READER CONTEXT SHOULD NOT LEAK/);
    assert.doesNotMatch(pack.markdown, /DENIED READER DERIVED ANALYSIS SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Context pack excludes runtime events with missing related context", () => withStore((store) => {
  store.appendRuntimeEvent({
    event_type: "agent_task.completed",
    actor: "agent",
    status: "completed",
    related_records: ["record:broker-event-missing-record"],
    payload: { summary: "MISSING BROKER EVENT RECORD SHOULD NOT LEAK" },
  });
  store.appendRuntimeEvent({
    event_type: "agent_task.completed",
    actor: "agent",
    status: "completed",
    related_views: ["analysis:broker-event-missing-view"],
    payload: { summary: "MISSING BROKER EVENT VIEW SHOULD NOT LEAK" },
  });
  const visible = store.appendRuntimeEvent({
    event_type: "agent_task.completed",
    actor: "agent",
    status: "completed",
    payload: { summary: "VISIBLE BROKER EVENT" },
  });

  const pack = buildContextPack({
    include_records: false,
    include_views: false,
    include_events: true,
    limit: 10,
  }, store);

  assert.deepEqual(pack.events.map(event => event.id), [visible.id]);
  assert.match(pack.markdown, /VISIBLE BROKER EVENT/);
  assert.doesNotMatch(pack.markdown, /MISSING BROKER EVENT/);
}));

test("Context pack filters runtime events by plugin allowed_event_types", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-event-permission-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "event-limited"), { recursive: true });
    writeFileSync(join(dir, "plugins", "event-limited", "plugin.json"), JSON.stringify({
      id: "event-limited",
      name: "Event Limited",
      permissions: {
        allowed_event_types: ["program.run.completed"],
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const allowed = store.appendRuntimeEvent({
      event_type: "program.run.completed",
      actor: "system",
      status: "completed",
      subject_type: "plugin",
      subject_id: "event-limited",
      plugin_id: "event-limited",
      payload: { reason: "ALLOWED EVENT SHOULD APPEAR" },
    });
    store.appendRuntimeEvent({
      event_type: "policy.denied_action",
      actor: "system",
      status: "denied",
      subject_type: "plugin",
      subject_id: "event-limited",
      plugin_id: "event-limited",
      payload: { reason: "DENIED EVENT SHOULD NOT LEAK" },
    });

    const pack = buildContextPack({
      plugin_id: "event-limited",
      include_records: false,
      include_views: false,
      include_events: true,
      limit: 8,
    }, store);

    assert.deepEqual(pack.events.map(event => event.id), [allowed.id]);
    assert.match(pack.markdown, /ALLOWED EVENT SHOULD APPEAR/);
    assert.doesNotMatch(pack.markdown, /DENIED EVENT SHOULD NOT LEAK/);
    assert.equal(pack.diagnostics.event_count, 1);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack sources exactly mirror visible packed records Views and events", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-broker-sources-consistency-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "visible-agent"), { recursive: true });
    writeFileSync(join(dir, "plugins", "visible-agent", "plugin.json"), JSON.stringify({
      id: "visible-agent",
      name: "Visible Agent",
      permissions: {
        allowed_sources: ["browser"],
        allowed_schemas: ["observation.browser_ambient_requested"],
        allowed_view_types: ["analysis.browser_page"],
        allowed_event_types: ["agent_task.completed"],
        max_privacy_level: "private",
        allow_external_llm: true,
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    store.insertRecord({
      id: "sources-visible-record",
      schema: { name: "observation.browser_ambient_requested", version: 1 },
      source: { type: "browser" },
      content: { title: "Visible browser source", text: "VISIBLE SOURCE CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "sources-hidden-record",
      schema: { name: "observation.git.diff", version: 1 },
      source: { type: "git" },
      content: { title: "Hidden git source", text: "HIDDEN SOURCE CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:sources-visible-view",
      view_type: "analysis.browser_page",
      title: "Visible analysis",
      source_records: ["sources-visible-record"],
      content: { analysis: "VISIBLE VIEW CONTEXT" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.upsertView({
      id: "analysis:sources-hidden-view",
      view_type: "analysis.browser_page",
      title: "Hidden analysis",
      source_records: ["sources-hidden-record"],
      content: { analysis: "HIDDEN VIEW CONTEXT SHOULD NOT LEAK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const visibleEvent = store.appendRuntimeEvent({
      event_type: "agent_task.completed",
      actor: "agent",
      status: "completed",
      subject_type: "plugin",
      subject_id: "visible-agent",
      plugin_id: "visible-agent",
      related_records: ["sources-visible-record"],
      related_views: ["analysis:sources-visible-view"],
      payload: { summary: "VISIBLE EVENT CONTEXT" },
    });
    store.appendRuntimeEvent({
      event_type: "agent_task.completed",
      actor: "agent",
      status: "completed",
      subject_type: "plugin",
      subject_id: "visible-agent",
      plugin_id: "visible-agent",
      related_records: ["sources-hidden-record"],
      related_views: ["analysis:sources-hidden-view"],
      payload: { summary: "HIDDEN EVENT CONTEXT SHOULD NOT LEAK" },
    });

    const pack = buildContextPack({
      plugin_id: "visible-agent",
      include_records: true,
      include_views: true,
      include_events: true,
      view_types: ["analysis.browser_page"],
      event_types: ["agent_task.completed"],
      limit: 8,
    }, store);

    const packedSourceKeys = [
      ...pack.records.map(record => `record:${record.id}`),
      ...pack.views.map(view => `view:${view.id}`),
      ...pack.events.map(event => `event:${event.id}`),
    ];
    const listedSourceKeys = pack.sources.map(source => `${source.kind}:${source.id}`);

    assert.deepEqual(listedSourceKeys, packedSourceKeys);
    assert.deepEqual(pack.records.map(record => record.id), ["sources-visible-record"]);
    assert.deepEqual(pack.views.map(view => view.id), ["analysis:sources-visible-view"]);
    assert.deepEqual(pack.events.map(event => event.id), [visibleEvent.id]);
    assert.doesNotMatch(JSON.stringify(pack.sources), /hidden/i);
    assert.doesNotMatch(pack.markdown, /SHOULD NOT LEAK/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Context pack surfacing diagnostics only include memory Views that affect ranking", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:surfacing-invalid-no-target",
    view_type: "memory.surfacing_preference",
    title: "Invalid surfacing memory",
    content: { preference: "show_less" },
    confidence: 0.9,
  });
  store.upsertView({
    id: "memory:surfacing-valid-browser",
    view_type: "memory.surfacing_preference",
    title: "Valid surfacing memory",
    content: {
      preference: "show_less",
      target_view_type: "analysis.browser_page",
    },
    confidence: 0.9,
  });
  store.upsertView({
    id: "analysis:diagnostics-surfacing",
    view_type: "analysis.browser_page",
    content: { analysis: "Surfacing diagnostics should name only effective memory." },
  });

  const pack = buildContextPack({
    include_views: true,
    include_records: false,
    view_type_prefix: "analysis.",
    limit: 4,
  }, store);

  assert.deepEqual(pack.diagnostics.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:surfacing-valid-browser"],
  });
}));


test("Context pack ignores surfacing memory with invalid provenance", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:dirty-surfacing-memory-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "other.example" },
    content: { title: "DIRTY SURFACING MEMORY SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:dirty-surfacing-browser",
    view_type: "memory.surfacing_preference",
    title: "Dirty show less browser analysis",
    source_records: ["record:dirty-surfacing-memory-source"],
    scope: { domain: "example.com" },
    content: {
      preference: "show_less",
      target_view_type: "analysis.browser_page",
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:repo-older-default",
    view_type: "analysis.repo",
    title: "Older repo analysis",
    content: { analysis: "Older repo analysis should not win without valid memory." },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:browser-newer-default",
    view_type: "analysis.browser_page",
    title: "Newer browser analysis",
    content: { analysis: "Newer browser analysis should win when dirty memory is ignored." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    include_views: true,
    include_records: false,
    view_type_prefix: "analysis.",
    limit: 1,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:browser-newer-default"]);
  assert.deepEqual(pack.diagnostics.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: [],
    source_view_ids: [],
  });
  assert.match(pack.markdown, /Newer browser analysis should win/);
  assert.doesNotMatch(pack.markdown, /Older repo analysis should not win/);
  assert.doesNotMatch(pack.markdown, /DIRTY SURFACING MEMORY/);
}));

test("Context pack lowers dismissed View types using surfacing memory", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:surfacing-dismissed-browser",
    view_type: "memory.surfacing_preference",
    title: "Show less browser analysis",
    content: {
      preference: "show_less",
      target_view_type: "analysis.browser_page",
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:repo-older-but-preferred",
    view_type: "analysis.repo",
    title: "Repo analysis should win",
    content: { analysis: "Non-dismissed analysis should be selected first." },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:dismissed-type-newer",
    view_type: "analysis.browser_page",
    title: "Newer dismissed type",
    content: { analysis: "Dismissed type should be lowered." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    include_views: true,
    include_records: false,
    view_type_prefix: "analysis.",
    limit: 1,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:repo-older-but-preferred"]);
  assert.deepEqual(pack.diagnostics.surfacing_preferences, {
    show_more_view_types: [],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:surfacing-dismissed-browser"],
  });
  assert.match(pack.markdown, /Non-dismissed analysis should be selected first/);
  assert.doesNotMatch(pack.markdown, /Dismissed type should be lowered/);
}));

test("Context pack raises useful View types using surfacing memory", async () => withStore(async (store) => {
  store.upsertView({
    id: "memory:surfacing-useful-browser-agent-task",
    view_type: "memory.surfacing_preference",
    title: "Show more browser AgentTask analysis",
    content: {
      preference: "show_more",
      target_view_type: "analysis.browser_agent_task",
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:agent-task-useful-type",
    view_type: "analysis.browser_agent_task",
    title: "Useful AgentTask analysis",
    content: { analysis: "Useful type should be raised." },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:repo-newer-default",
    view_type: "analysis.repo",
    title: "Newer repo analysis default",
    content: { analysis: "Default newer analysis should not win over useful type." },
    privacy: { level: "private", retention: "normal" },
  });

  const pack = buildContextPack({
    include_views: true,
    include_records: false,
    view_type_prefix: "analysis.",
    limit: 1,
  }, store);

  assert.deepEqual(pack.views.map(view => view.id), ["analysis:agent-task-useful-type"]);
  assert.deepEqual(pack.diagnostics.surfacing_preferences, {
    show_more_view_types: ["analysis.browser_agent_task"],
    show_less_view_types: [],
    source_view_ids: ["memory:surfacing-useful-browser-agent-task"],
  });
  assert.match(pack.markdown, /Useful type should be raised/);
  assert.doesNotMatch(pack.markdown, /Default analysis should not win/);
}));

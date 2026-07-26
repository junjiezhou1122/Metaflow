import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";

function withDb(fn: (dbPath: string, store: ContextStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "info-mf-cli-test-"));
  const dbPath = join(dir, "context.sqlite");
  const store = new ContextStore(dbPath);
  try {
    fn(dbPath, store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mf(dbPath: string, args: string[]) {
  return execFileSync("node", ["--no-warnings", "--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
}

function mfWithEnv(dbPath: string, args: string[], env: NodeJS.ProcessEnv) {
  return execFileSync("node", ["--no-warnings", "--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
}

test("mf processor list and report expose built-in processors", () => withDb((dbPath) => {
  const list = mf(dbPath, ["processor", "list"]);
  assert.match(list, /processor\.surface_state/);
  assert.match(list, /processor\.route_candidate/);
  assert.match(list, /processor\.view_promotion_engine/);
  assert.match(list, /runtime/);
  assert.match(list, /autonomy/);

  const report = mf(dbPath, ["processor", "report"]);
  assert.match(report, /warnings:/);
}));

test("mf help exposes agent-facing CLI commands", () => withDb((dbPath) => {
  const help = JSON.parse(mf(dbPath, ["--json", "help"])) as { ok: boolean; data: { usage: string[] } };
  assert.equal(help.ok, true);
  assert.ok(help.data.usage.some(line => line.includes("sensor screenpipe search")));
  assert.ok(help.data.usage.some(line => line.includes("memory daily show|write|sync")));
  assert.ok(help.data.usage.some(line => line.includes("view upsert")));
}));

test("mf view latest and trace inspect stored views", () => withDb((dbPath, store) => {
  const record = store.insertRecord({
    id: "obs:mf:source",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session" },
    content: { title: "Source observation" },
  });
  store.upsertView({
    id: "view:mf:focus",
    view_type: "work.focus_set",
    title: "Work Focus",
    status: "candidate",
    source_records: [record.id],
    compiler: { id: "processor.work_router_batch", mode: "deterministic" },
    content: { active_lanes: [] },
  });

  const latest = mf(dbPath, ["view", "latest", "work.focus_set"]);
  assert.match(latest, /work\.focus_set/);
  assert.match(latest, /view:mf:focus/);

  const trace = mf(dbPath, ["view", "trace", "view:mf:focus"]);
  assert.match(trace, /compiler: processor\.work_router_batch deterministic/);
  assert.match(trace, /source_records: obs:mf:source/);
  assert.match(trace, /record obs:mf:source: observation\.ai_session_locator_result Source observation/);
}));

test("mf view trace returns non-zero for unknown view", () => withDb((dbPath) => {
  const result = spawnSync("node", ["--no-warnings", "--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", "view", "trace", "missing"], {
    cwd: process.cwd(),
    env: { ...process.env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /View not found: missing/);
}));

test("mf --json emits stable success and error envelopes", () => withDb((dbPath, store) => {
  store.upsertView({
    id: "view:mf:json",
    view_type: "project.current",
    title: "JSON Project",
    status: "accepted",
    content: { focus: "JSON contract" },
  });

  const latest = JSON.parse(mf(dbPath, ["--json", "view", "latest", "project.current"])) as {
    ok: boolean;
    command: string;
    data: { view_type: string; views: Array<{ id: string; view_type: string; content: Record<string, unknown> }> };
  };
  assert.equal(latest.ok, true);
  assert.equal(latest.command, "mf view latest project.current");
  assert.equal(latest.data.view_type, "project.current");
  assert.equal(latest.data.views[0]?.id, "view:mf:json");
  assert.equal(latest.data.views[0]?.content.focus, "JSON contract");

  const missing = spawnSync("node", ["--no-warnings", "--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", "--json", "view", "trace", "missing"], {
    cwd: process.cwd(),
    env: { ...process.env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");
  const error = JSON.parse(missing.stderr) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "VIEW_NOT_FOUND");
  assert.equal(error.error.message, "View not found: missing");
}));

test("mf state returns canonical Agent Surface views", () => withDb((dbPath, store) => {
  store.upsertView({
    id: "view:state:project",
    view_type: "project.current",
    title: "Current project",
    status: "accepted",
    compiler: { id: "processor.project_current", mode: "deterministic" },
    source_records: ["obs:missing"],
    content: { project_path: "/Users/junjie/info" },
  });

  const state = JSON.parse(mf(dbPath, ["--json", "state"])) as {
    ok: boolean;
    data: {
      views: Array<{
        view_type: string;
        latest: { id: string; content: Record<string, unknown> } | null;
        provenance: { producer?: string; source_record_count: number } | null;
      }>;
    };
  };
  assert.equal(state.ok, true);
  assert.deepEqual(state.data.views.map(view => view.view_type), [
    "state.surface",
    "work.focus_set",
    "project.current",
    "memory.daily",
    "memory.profile",
  ]);
  const project = state.data.views.find(view => view.view_type === "project.current");
  assert.equal(project?.latest?.id, "view:state:project");
  assert.equal(project?.latest?.content.project_path, "/Users/junjie/info");
  assert.equal(project?.provenance?.producer, "processor.project_current");
  assert.equal(project?.provenance?.source_record_count, 1);
}));

test("mf task list and queue expose the unified agent task surface", () => withDb((dbPath, store) => {
  const source = store.insertRecord({
    id: "obs:task-surface",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "Task surface source" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:background-research:cli",
    view_type: "task.background_research",
    title: "CLI queued task",
    source_records: [source.id],
    content: { focus: "task surface", goal: "Inspect task list" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const list = JSON.parse(mf(dbPath, ["--json", "task", "list", "--refresh"])) as {
    ok: boolean;
    data: { task_list: { counts: Record<string, number>; items: Array<{ view_type: string }> }; view: { view_type: string } | null };
  };
  assert.equal(list.ok, true);
  assert.equal(list.data.task_list.counts.candidate, 1);
  assert.equal(list.data.task_list.items[0]?.view_type, "task.background_research");
  assert.equal(list.data.view?.view_type, "agent.task_list");

  const queue = JSON.parse(mf(dbPath, ["--json", "task", "queue", "--limit", "1"])) as { ok: boolean; data: { result: { mode: string; queued: number } } };
  assert.equal(queue.ok, true);
  assert.equal(queue.data.result.mode, "queue");
  assert.equal(queue.data.result.queued >= 0, true);
}));

test("mf view upsert writes dynamic Views with agent provenance", () => withDb((dbPath, store) => {
  const source = store.insertRecord({
    id: "obs:dynamic-view",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "Dynamic source" },
  });
  const file = join(tmpdir(), `info-mf-view-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({
    id: "view:dynamic:agent",
    view_type: "custom.agent_note",
    title: "Agent note",
    status: "accepted",
    source_records: [source.id],
    content: { note: "agent-created dynamic view" },
  }));

  const result = JSON.parse(mf(dbPath, ["--json", "view", "upsert", file])) as {
    ok: boolean;
    data: { view: { id: string; view_type: string; producer?: string; content: Record<string, unknown> } };
  };
  assert.equal(result.ok, true);
  assert.equal(result.data.view.id, "view:dynamic:agent");
  assert.equal(result.data.view.view_type, "custom.agent_note");
  assert.equal(result.data.view.producer, "agent.create_view");
  assert.equal(store.getView("view:dynamic:agent")?.metadata?.created_via, "agent_surface_cli");
  assert.ok(store.listRuntimeEvents({ event_types: ["agent_surface.view_upserted"], limit: 5 }).some(event => event.subject_id === "view:dynamic:agent"));
}));

test("mf view graph commands fork update list children and delete views", () => withDb((dbPath, store) => {
  store.upsertView({
    id: "view:graph:root",
    view_type: "project.current",
    title: "Root view",
    status: "accepted",
    content: { project: "info", nested: { old: true } },
    metadata: { lane: "root" },
  });
  const patchFile = join(tmpdir(), `info-mf-view-patch-${Date.now()}.json`);
  writeFileSync(patchFile, JSON.stringify({
    content: { nested: { new: true }, task: "browser" },
    metadata: { lane: "browser" },
  }));

  const fork = JSON.parse(mf(dbPath, [
    "--json",
    "view",
    "fork",
    "view:graph:root",
    "--id",
    "view:graph:child",
    "--view-type",
    "custom.browser_task",
    "--title",
    "Browser task",
    "--patch",
    patchFile,
  ])) as { ok: boolean; data: { view: { id: string; view_type: string; source_views: string[]; content: any; producer?: string } } };
  assert.equal(fork.ok, true);
  assert.equal(fork.data.view.id, "view:graph:child");
  assert.equal(fork.data.view.view_type, "custom.browser_task");
  assert.deepEqual(fork.data.view.source_views, ["view:graph:root"]);
  assert.equal(fork.data.view.content.nested.old, true);
  assert.equal(fork.data.view.content.nested.new, true);
  assert.equal(fork.data.view.producer, "agent.fork_view");

  const children = JSON.parse(mf(dbPath, ["--json", "view", "children", "view:graph:root"])) as {
    ok: boolean;
    data: { children: Array<{ id: string }> };
  };
  assert.equal(children.ok, true);
  assert.deepEqual(children.data.children.map(view => view.id), ["view:graph:child"]);

  const updatePatch = join(tmpdir(), `info-mf-view-update-${Date.now()}.json`);
  writeFileSync(updatePatch, JSON.stringify({ content: { task: "done" }, metadata: { reviewed: true } }));
  const update = JSON.parse(mf(dbPath, [
    "--json",
    "view",
    "update",
    "view:graph:child",
    "--status",
    "accepted",
    "--patch",
    updatePatch,
  ])) as { ok: boolean; data: { view: { status: string; content: any; source_views: string[] } } };
  assert.equal(update.ok, true);
  assert.equal(update.data.view.status, "accepted");
  assert.equal(update.data.view.content.task, "done");
  assert.deepEqual(update.data.view.source_views, ["view:graph:root"]);

  const archive = JSON.parse(mf(dbPath, ["--json", "view", "delete", "view:graph:child", "--reason", "no longer needed"])) as {
    ok: boolean;
    data: { deleted: boolean; hard: boolean; view: { status: string } };
  };
  assert.equal(archive.ok, true);
  assert.equal(archive.data.deleted, true);
  assert.equal(archive.data.hard, false);
  assert.equal(archive.data.view.status, "archived");
  assert.equal(store.getView("view:graph:child")?.status, "archived");

  const hardDelete = JSON.parse(mf(dbPath, ["--json", "view", "delete", "view:graph:child", "--hard"])) as {
    ok: boolean;
    data: { deleted: boolean; hard: boolean };
  };
  assert.equal(hardDelete.ok, true);
  assert.equal(hardDelete.data.hard, true);
  assert.equal(store.getView("view:graph:child"), undefined);
  assert.ok(store.listRuntimeEvents({ event_types: ["agent_surface.view_forked"], limit: 5 }).some(event => event.subject_id === "view:graph:child"));
  assert.ok(store.listRuntimeEvents({ event_types: ["agent_surface.view_deleted"], limit: 5 }).some(event => event.subject_id === "view:graph:child"));
}));

test("mf processor run triggers a whitelisted processor and records evidence", () => withDb((dbPath, store) => {
  const source = store.insertRecord({
    id: "obs:processor-run",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { title: "Info project", path: "/Users/junjie/info" },
  });

  const result = JSON.parse(mf(dbPath, ["--json", "processor", "run", "processor.route_candidate", "--record", source.id])) as {
    ok: boolean;
    data: {
      result: {
        processors_matched: string[];
        observations_written: string[];
        runs: Array<{ ok: boolean; processor_id: string }>;
      };
    };
  };

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.result.processors_matched, ["processor.route_candidate"]);
  assert.equal(result.data.result.runs[0]?.ok, true);
  assert.equal(result.data.result.runs[0]?.processor_id, "processor.route_candidate");
  assert.ok(result.data.result.observations_written.length >= 1);
  assert.ok(store.recent(10).some(record => record.schema.name === "observation.route_candidate"));
  assert.ok(store.listRuntimeEvents({ event_types: ["processor.run.completed"], limit: 10 }).some(event => event.plugin_id === "processor.route_candidate"));
}));

test("mf processor run can produce View promotion candidates", () => withDb((dbPath, store) => {
  const source = store.insertRecord({
    id: "obs:promotion-cli",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "Info project" },
  });
  for (let index = 0; index < 3; index += 1) {
    store.insertRecord({
      id: `route:promotion-cli:${index}`,
      schema: { name: "observation.route_candidate", version: 1 },
      source: { type: "runtime", connector: "processor.route_candidate" },
      payload: {
        candidate_routes: [{
          route_key: "topic:chrome-acp",
          lane_kind: "topic",
          score: 0.7,
          rule_hits: ["topic.token"],
        }],
      },
    });
  }

  const result = JSON.parse(mf(dbPath, ["--json", "processor", "run", "processor.view_promotion_engine", "--record", source.id])) as {
    ok: boolean;
    data: { result: { processors_matched: string[]; views_written: string[] } };
  };

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.result.processors_matched, ["processor.view_promotion_engine"]);
  const view = store.getView(result.data.result.views_written[0]);
  assert.equal(view?.view_type, "view.promotion_candidates");
  const candidates = view?.content?.candidates as Array<Record<string, unknown>>;
  assert.ok(candidates.some(candidate => candidate.action === "create_view" && candidate.target_view_type === "brief.research"));
}));

test("mf sensor screenpipe search passes filters, normalizes records, and can write observations", () => withDb((dbPath, store) => {
  const dir = mkdtempSync(join(tmpdir(), "info-mf-screenpipe-bin-"));
  const bin = join(dir, "screenpipe");
  writeFileSync(bin, `#!/bin/sh
echo "$@" > "$SCREENPIPE_ARGS_FILE"
if [ "$1" = "search" ]; then
  printf '%s\\n' '{"type":"ocr","content":{"id":"frame-1","timestamp":"2026-06-17T01:02:03.000Z","app_name":"Cursor","window_name":"Metaflow","browser_url":"https://github.com/junjiezhou1122/Metaflow","text":"Agent Surface CLI"}}'
else
  printf '%s\\n' '{"running":true}'
fi
`);
  execFileSync("chmod", ["+x", bin]);
  const argsFile = join(dir, "args.txt");
  try {
    const result = JSON.parse(mfWithEnv(dbPath, [
      "--json",
      "sensor",
      "screenpipe",
      "search",
      "Agent Surface",
      "--write",
      "--focused",
      "--app",
      "Cursor",
      "--browser-url",
      "github.com",
      "--start",
      "30m ago",
    ], { PATH: `${dir}:${process.env.PATH ?? ""}`, SCREENPIPE_ARGS_FILE: argsFile })) as {
      ok: boolean;
      data: { count: number; written_records: string[]; records: Array<{ schema: string; title?: string }> };
    };
    assert.equal(result.ok, true);
    assert.equal(result.data.count, 1);
    assert.equal(result.data.records[0]?.schema, "observation.screenpipe_activity");
    assert.equal(result.data.written_records.length, 1);
    assert.ok(store.recent(10).some(record => record.source.type === "screenpipe" && record.content?.text === "Agent Surface CLI"));
    assert.ok(store.listRuntimeEvents({ event_types: ["agent_surface.screenpipe_search"], limit: 10 }).length >= 1);
    const passedArgs = readFileSync(argsFile, "utf8");
    assert.match(passedArgs, /--focused/);
    assert.match(passedArgs, /--app Cursor/);
    assert.match(passedArgs, /--browser-url github\.com/);
    assert.match(passedArgs, /--json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("mf view merge split diff promote graph operations", () => withDb((dbPath, store) => {
  store.upsertView({
    id: "view:graph:a",
    view_type: "project.current",
    title: "View A",
    status: "accepted",
    content: { focus: "alpha", shared: "old" },
  });
  store.upsertView({
    id: "view:graph:b",
    view_type: "project.current",
    title: "View B",
    status: "accepted",
    content: { detail: "beta", shared: "new" },
  });

  const merge = JSON.parse(mf(dbPath, [
    "--json", "view", "merge",
    "--source-view", "view:graph:a",
    "--source-view", "view:graph:b",
    "--id", "view:graph:merged",
  ])) as { ok: boolean; data: { view: { id: string; source_views: string[] } } };
  assert.equal(merge.ok, true);
  assert.equal(merge.data.view.id, "view:graph:merged");
  assert.deepEqual(merge.data.view.source_views, ["view:graph:a", "view:graph:b"]);

  const split = JSON.parse(mf(dbPath, ["--json", "view", "split", "view:graph:a", "--into", "2"])) as {
    ok: boolean;
    data: { views: Array<{ id: string }> };
  };
  assert.equal(split.ok, true);
  assert.equal(split.data.views.length, 2);

  const diff = JSON.parse(mf(dbPath, ["--json", "view", "diff", "view:graph:a", "view:graph:b"])) as {
    ok: boolean;
    data: { diff: { added: Record<string, unknown>; removed: Record<string, unknown>; changed: Record<string, unknown> } };
  };
  assert.equal(diff.ok, true);
  assert.ok("detail" in diff.data.diff.added);
  assert.ok("focus" in diff.data.diff.removed);
  assert.ok("shared" in diff.data.diff.changed);

  const promote = JSON.parse(mf(dbPath, ["--json", "view", "promote", "view:graph:a", "--view-type", "work.focus_set"])) as {
    ok: boolean;
    data: { view: { view_type: string } };
  };
  assert.equal(promote.ok, true);
  assert.equal(promote.data.view.view_type, "work.focus_set");
}));

test("mf memory lifecycle demote archive consolidate commands", () => withDb((dbPath, store) => {
  store.upsertView({ id: "memory:test:demote", view_type: "memory.daily", title: "Daily", status: "accepted" });
  store.upsertView({ id: "memory:test:archive", view_type: "memory.profile", title: "Profile", status: "accepted" });
  store.upsertView({ id: "memory:test:c1", view_type: "memory.daily", title: "C1" });
  store.upsertView({ id: "memory:test:c2", view_type: "memory.daily", title: "C2" });

  const demote = JSON.parse(mf(dbPath, ["--json", "memory", "demote", "memory:test:demote"])) as { ok: boolean; data: { status: string } };
  assert.equal(demote.ok, true);
  assert.equal(demote.data.status, "candidate");
  assert.equal(store.getView("memory:test:demote")?.status, "candidate");

  const archive = JSON.parse(mf(dbPath, ["--json", "memory", "archive", "memory:test:archive", "stale"])) as { ok: boolean; data: { status: string } };
  assert.equal(archive.ok, true);
  assert.equal(archive.data.status, "archived");
  assert.equal(store.getView("memory:test:archive")?.status, "archived");

  const consolidate = JSON.parse(mf(dbPath, ["--json", "memory", "consolidate", "memory:test:c1", "memory:test:c2"])) as {
    ok: boolean;
    data: { primary_id: string; status: string; archived_ids: string[] };
  };
  assert.equal(consolidate.ok, true);
  assert.equal(consolidate.data.primary_id, "memory:test:c1");
  assert.equal(consolidate.data.status, "accepted");
  assert.deepEqual(consolidate.data.archived_ids, ["memory:test:c2"]);
  assert.equal(store.getView("memory:test:c2")?.status, "archived");
}));

test("mf evolution candidates show apply verify rollback", () => withDb((dbPath, store) => {
  store.upsertView({
    id: "view:stale:evo",
    view_type: "project.current",
    status: "accepted",
    content: { focus: "stale" },
  });
  store.upsertView({
    id: "view:promo:evo",
    view_type: "view.promotion_candidates",
    title: "Promotion batch",
    status: "candidate",
    compiler: { id: "processor.view_promotion_engine", mode: "deterministic" },
    content: {
      candidates: [
        { id: "cand:create:evo", action: "create_view", target_view_type: "brief.research", priority: "high", reason: "Repeated research", rollback: { strategy: "archive_created" } },
        { id: "cand:retire:evo", action: "retire_view", target_view_id: "view:stale:evo", priority: "low", reason: "Stale view" },
      ],
    },
  });

  const candidates = JSON.parse(mf(dbPath, ["--json", "evolution", "candidates"])) as { ok: boolean; data: { candidates: Array<{ id: string }> } };
  assert.equal(candidates.ok, true);
  assert.equal(candidates.data.candidates.length, 2);

  const showBefore = JSON.parse(mf(dbPath, ["--json", "evolution", "show", "cand:create:evo"])) as {
    ok: boolean;
    data: { candidate: { id: string }; operations: unknown[] };
  };
  assert.equal(showBefore.data.candidate.id, "cand:create:evo");
  assert.equal(showBefore.data.operations.length, 0);

  const apply = JSON.parse(mf(dbPath, ["--json", "evolution", "apply", "cand:create:evo", "--mode", "full_auto", "--id", "view:evo:research"])) as {
    ok: boolean;
    data: { operation_id: string; applied_view_id: string | null };
  };
  assert.equal(apply.ok, true);
  assert.equal(apply.data.applied_view_id, "view:evo:research");
  assert.equal(store.getView("view:evo:research")?.status, "accepted");
  assert.equal(store.getView(apply.data.operation_id)?.view_type, "evolution.operation");
  assert.ok(store.listRuntimeEvents({ event_type: "evolution.applied", limit: 5 }).some(event => event.payload?.candidate_id === "cand:create:evo"));

  const verify = JSON.parse(mf(dbPath, ["--json", "evolution", "verify", "cand:create:evo"])) as {
    ok: boolean;
    data: { operations: Array<{ id: string }> };
  };
  assert.equal(verify.ok, true);
  assert.equal(verify.data.operations[0]?.id, apply.data.operation_id);

  const rollback = JSON.parse(mf(dbPath, ["--json", "evolution", "rollback", "cand:create:evo"])) as {
    ok: boolean;
    data: { rolled_back_operations: string[] };
  };
  assert.equal(rollback.ok, true);
  assert.deepEqual(rollback.data.rolled_back_operations, [apply.data.operation_id]);
  assert.equal(store.getView("view:evo:research")?.status, "archived");
  assert.equal(store.getView(apply.data.operation_id)?.status, "archived");

  const retire = JSON.parse(mf(dbPath, ["--json", "evolution", "apply", "cand:retire:evo"])) as {
    ok: boolean;
    data: { applied_view_id: string | null };
  };
  assert.equal(retire.ok, true);
  assert.equal(retire.data.applied_view_id, "view:stale:evo");
  assert.equal(store.getView("view:stale:evo")?.status, "archived");
}));

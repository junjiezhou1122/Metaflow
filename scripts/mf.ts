import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContextStore, ContextViewSchema, filterViewsByQuery, type ContextView, type StoredContextRecord, type StoredContextView } from "@info/core";
import { builtinViewSpecs, createViewRegistry, searchViewSpecs, type ViewSpec } from "@info/view-system";
import { normalizeScreenpipeResult } from "@info/sensors";
import { buildAgentTaskList, queueOrProcessAgentTasks } from "@info/runtime/agent-tasks.js";
import {
  buildProcessorViewReport,
  ProcessorRuntime,
  createCurrentPageRouterProcessor,
  createRouteCandidateProcessor,
  createScreenpipeSurfaceProcessor,
  createSurfaceStateProcessor,
  createViewPromotionEngineProcessor,
  type ProcessorDefinition,
} from "@info/processor-runtime";
import { compileMemoryGate as compileMemoryGateView } from "@info/views";

const registry = createViewRegistry(builtinViewSpecs());
const store = new ContextStore();
const CANONICAL_AGENT_SURFACE_VIEW_TYPES = [
  "state.surface",
  "work.focus_set",
  "project.current",
  "memory.daily",
  "memory.profile",
] as const;
let jsonOutput = false;
let currentCommand = "mf";

type CliEnvelope<T> = {
  ok: true;
  command: string;
  data: T;
};

type CliErrorEnvelope = {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
  };
};

async function main(argv: string[]): Promise<void> {
  const parsed = parseGlobalArgs(argv);
  jsonOutput = parsed.json;
  argv = parsed.argv;
  currentCommand = ["mf", ...argv].join(" ");
  const [area, command, ...rest] = argv;
  if (!area || area === "help" || area === "--help" || area === "-h") {
    printHelp();
    return;
  }
  if (area === "state") {
    if (!command || command === "surface") {
      printAgentSurfaceState();
      return;
    }
    fail("unknown command", "UNKNOWN_COMMAND");
    return;
  }
  if (area === "sensor") {
    if (command === "screenpipe") {
      await handleScreenpipeCommand(rest);
      return;
    }
    fail("unknown command", "UNKNOWN_COMMAND");
    return;
  }
  if (area !== "view") {
    if (area === "processor") {
      if (command === "list") {
        printProcessorList();
        return;
      }
      if (command === "report") {
        printProcessorReport();
        return;
      }
      if (command === "run") {
        await runProcessor(rest);
        return;
      }
    }
    if (area === "memory") {
      if (command === "daily") {
        handleMarkdownMemoryCommand("daily", rest);
        return;
      }
      if (command === "profile") {
        handleMarkdownMemoryCommand("profile", rest);
        return;
      }
      if (command === "list") {
        printMemoryList();
        return;
      }
      if (command === "candidates") {
        printMemoryCandidates();
        return;
      }
      if (command === "trace") {
        const id = required(rest[0], "memory_id");
        printMemoryTrace(id);
        return;
      }
      if (command === "reject") {
        const id = required(rest[0], "candidate_id");
        rejectMemoryCandidate(id, rest.slice(1).join(" ").trim() || "manual rejection");
        return;
      }
      if (command === "promote") {
        const id = required(rest[0], "candidate_id");
        promoteMemoryCandidate(id);
        return;
      }
    }
    if (area === "task") {
      if (command === "list") {
        printAgentTaskList(rest);
        return;
      }
      if (command === "queue") {
        await runAgentTaskQueue("queue", rest);
        return;
      }
      if (command === "process") {
        await runAgentTaskQueue("process", rest);
        return;
      }
    }
    fail("unknown command", "UNKNOWN_COMMAND");
    return;
  }

  if (command === "list") {
    printViewList(registry.list());
    return;
  }

  if (command === "show") {
    const viewType = required(rest[0], "view_type");
    printViewShow(viewType);
    return;
  }

  if (command === "latest") {
    const viewType = required(rest[0], "view_type");
    printViewLatest(viewType);
    return;
  }

  if (command === "trace") {
    const viewId = required(rest[0], "view_id");
    printViewTrace(viewId);
    return;
  }

  if (command === "json") {
    const viewType = required(rest[0], "view_type");
    printViewJson(viewType);
    return;
  }

  if (command === "search") {
    const query = required(rest.join(" "), "query");
    printViewSearch(query);
    return;
  }

  if (command === "upsert") {
    upsertViewFromCli(rest);
    return;
  }

  if (command === "fork") {
    forkViewFromCli(rest);
    return;
  }

  if (command === "update") {
    updateViewFromCli(rest);
    return;
  }

  if (command === "delete") {
    deleteViewFromCli(rest);
    return;
  }

  if (command === "children") {
    printViewChildren(required(rest[0], "view_id"), rest);
    return;
  }

  fail("unknown command", "UNKNOWN_COMMAND");
}

function builtInProcessors(): ProcessorDefinition[] {
  return [
    createSurfaceStateProcessor(),
    createRouteCandidateProcessor(),
    createCurrentPageRouterProcessor(),
    createScreenpipeSurfaceProcessor(),
    createViewPromotionEngineProcessor(),
  ];
}

function printProcessorList(): void {
  const rows = builtInProcessors().map(processor => ({
    processor_id: processor.id,
    runtime: processor.runtime.kind,
    speed: processor.policy?.speed ?? "-",
    autonomy: processor.policy?.autonomy ?? "-",
    produces: [
      ...(processor.produces.views ?? []),
      ...(processor.produces.observations ?? []),
      ...(processor.produces.events ?? []),
    ].join(",") || "-",
  }));
  if (jsonOutput) {
    emitJson({ processors: rows });
    return;
  }
  printTable(rows, ["processor_id", "runtime", "speed", "autonomy", "produces"]);
}

function printProcessorReport(): void {
  const report = buildProcessorViewReport(builtInProcessors(), registry);
  if (jsonOutput) {
    emitJson({ report });
    return;
  }
  for (const processor of report.processors) {
    out(`${processor.id}`);
    out(`  runtime: ${processor.runtime}`);
    out(`  consumes.observations: ${processor.consumes.observations.join(", ") || "-"}`);
    out(`  consumes.views: ${processor.consumes.views.join(", ") || "-"}`);
    out(`  produces.views: ${processor.produces.views.join(", ") || "-"}`);
    out(`  policy: speed=${processor.policy.speed ?? "-"} autonomy=${processor.policy.autonomy ?? "-"} privacy=${processor.policy.privacy ?? "-"}`);
    if (processor.warnings.length) out(`  warnings: ${processor.warnings.join("; ")}`);
  }
  out(`warnings: ${report.warnings.length ? report.warnings.join("; ") : "none"}`);
}

async function runProcessor(args: string[]): Promise<void> {
  const processorId = required(args[0], "processor_id");
  const processor = builtInProcessors().find(item => item.id === processorId);
  if (!processor) {
    fail(`Processor not found or not runnable from mf: ${processorId}`, "PROCESSOR_NOT_FOUND");
    return;
  }
  const recordId = valueAfter(args, "--record");
  const viewId = valueAfter(args, "--view");
  if (recordId && viewId) {
    fail("processor run accepts either --record or --view, not both", "INVALID_ARGUMENT");
    return;
  }
  const runtime = new ProcessorRuntime({ store, processors: [processor] });
  if (recordId) {
    const record = store.getRecord(recordId);
    if (!record) {
      fail(`Record not found: ${recordId}`, "RECORD_NOT_FOUND");
      return;
    }
    const result = await runtime.processObservation(record);
    emitProcessorRunResult(result);
    return;
  }
  if (viewId) {
    const view = store.getView(viewId);
    if (!view) {
      fail(`View not found: ${viewId}`, "VIEW_NOT_FOUND");
      return;
    }
    const result = await runtime.processView(view);
    emitProcessorRunResult(result);
    return;
  }
  fail("processor run requires --record <id> or --view <id>", "INVALID_ARGUMENT");
}

function emitProcessorRunResult(result: Awaited<ReturnType<ProcessorRuntime["processObservation"]>>): void {
  if (jsonOutput) {
    emitJson({ result });
    return;
  }
  out(`processors_matched: ${result.processors_matched.join(", ") || "-"}`);
  out(`views_written: ${result.views_written.join(", ") || "-"}`);
  out(`observations_written: ${(result.observations_written ?? []).join(", ") || "-"}`);
  for (const run of result.runs) {
    out(`${run.ok ? "ok" : "failed"} ${run.processor_id}`);
    if (run.error) out(`  error: ${run.error}`);
  }
}

function printAgentSurfaceState(): void {
  const items = CANONICAL_AGENT_SURFACE_VIEW_TYPES.map(viewType => {
    const latest = store.listViews({ view_types: [viewType], active_only: true, limit: 1 })[0];
    return {
      view_type: viewType,
      spec: registry.get(viewType) ?? null,
      latest: latest ? viewSummary(latest) : null,
      provenance: latest ? provenanceSummary(latest) : null,
    };
  });
  if (jsonOutput) {
    emitJson({ views: items });
    return;
  }
  printTable(items.map(item => ({
    view_type: item.view_type,
    latest: item.latest ? String(item.latest.id) : "-",
    status: item.latest ? String(item.latest.status ?? "-") : "-",
    updated_at: item.latest ? String(item.latest.updated_at ?? "-") : "-",
  })), ["view_type", "latest", "status", "updated_at"]);
}

function printAgentTaskList(args: string[]): void {
  const refresh = args.includes("--refresh");
  const list = buildAgentTaskList({ write: refresh, limit: numberAfter(args, "--limit") ?? 100 }, store);
  if (jsonOutput) {
    emitJson({ task_list: list, view: list.latest_view ? viewSummary(list.latest_view) : null });
    return;
  }
  out(`agent tasks: ${list.items.length}`);
  out(`queued=${list.counts.queued} candidate=${list.counts.candidate} completed=${list.counts.completed} failed=${list.counts.failed} skipped=${list.counts.skipped}`);
  printTable(list.items.map(item => ({
    status: item.status,
    view_type: item.view_type,
    id: item.id,
    runtime: item.runtime ?? "-",
    title: (item.title ?? item.summary ?? "").slice(0, 100),
  })), ["status", "view_type", "id", "runtime", "title"]);
}

async function runAgentTaskQueue(mode: "queue" | "process", args: string[]): Promise<void> {
  const runtime = valueAfter(args, "--runtime");
  const dryRun = args.includes("--dry-run");
  const limit = numberAfter(args, "--limit");
  const autonomy = valueAfter(args, "--autonomy") as any;
  const result = await queueOrProcessAgentTasks({
    mode,
    runtime,
    dry_run: dryRun,
    limit,
    autonomy,
    write: !dryRun,
  }, store);
  if (jsonOutput) {
    emitJson({ result });
    return;
  }
  out(`mode=${result.mode} queued=${result.queued} processed=${result.processed} skipped=${result.skipped}`);
  for (const task of result.tasks) out(`${task.status} ${task.task_view_type} ${task.task_view_id}${task.reason ? ` ${task.reason}` : ""}`);
}

function numberAfter(args: string[], flag: string): number | undefined {
  const value = valueAfter(args, flag);
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function printViewList(specs: ViewSpec[]): void {
  const rows = specs.map(spec => ({
    view_type: spec.view_type,
    lifecycle: spec.lifecycle,
    producers: (spec.producers ?? []).map(producer => producer.id).join(",") || "-",
    purpose: spec.purpose,
  }));
  if (jsonOutput) {
    emitJson({ specs, rows });
    return;
  }
  printTable(rows, ["view_type", "lifecycle", "producers", "purpose"]);
}

function printViewShow(viewType: string): void {
  const spec = registry.get(viewType);
  const latest = store.listViews({ view_types: [viewType], active_only: true, limit: 5 });

  if (!spec) {
    if (jsonOutput) {
      emitJson({ spec: null, latest: latest.map(viewSummary) });
      return;
    }
    out(`View spec not found: ${viewType}`);
  } else {
    if (jsonOutput) {
      emitJson({ spec, latest: latest.map(viewSummary) });
      return;
    }
    out(`${spec.view_type}`);
    out(`  title: ${spec.title}`);
    out(`  lifecycle: ${spec.lifecycle}`);
    out(`  producers: ${(spec.producers ?? []).map(producer => `${producer.id}:${producer.kind}`).join(", ") || "-"}`);
    out(`  purpose: ${spec.purpose}`);
    if (spec.subject?.description) out(`  subject: ${spec.subject.description}`);
  }

  if (!latest.length) {
    out("  latest views: none");
    return;
  }

  out("  latest views:");
  for (const view of latest) {
    out(`  - ${view.id} ${view.status ?? "candidate"} ${view.updated_at}`);
    if (view.title) out(`    ${view.title}`);
    if (view.summary) out(`    ${view.summary}`);
  }
}

function printViewLatest(viewType: string): void {
  const latest = store.listViews({ view_types: [viewType], active_only: true, limit: 10 });
  if (jsonOutput) {
    emitJson({ view_type: viewType, views: latest.map(viewSummary) });
    return;
  }
  if (!latest.length) {
    out(`No active views found for ${viewType}`);
    return;
  }
  for (const view of latest) printStoredViewLine(view);
}

function printViewJson(viewType: string): void {
  const spec = registry.get(viewType);
  const latest = store.listViews({ view_types: [viewType], active_only: true, limit: 5 });
  if (jsonOutput) {
    emitJson({ spec, latest: latest.map(viewSummary) });
    return;
  }
  out(JSON.stringify({ spec, latest }, null, 2));
}

function printViewTrace(viewId: string): void {
  const view = store.getView(viewId);
  if (!view) {
    fail(`View not found: ${viewId}`, "VIEW_NOT_FOUND");
    return;
  }
  const sourceRecords = (view.source_records ?? []).map(id => {
    const record = store.getRecord(id);
    return {
      id,
      schema: record?.schema.name ?? "missing",
      title: record?.content?.title,
      url: record?.content?.url,
    };
  });
  const sourceViews = (view.source_views ?? []).map(id => {
    const sourceView = store.getView(id);
    return {
      id,
      view_type: sourceView?.view_type ?? "missing",
      title: sourceView?.title,
    };
  });
  if (jsonOutput) {
    emitJson({
      view: viewSummary(view),
      provenance: {
        producer: view.compiler?.id,
        source_record_count: sourceRecords.length,
        source_view_count: sourceViews.length,
        source_records: sourceRecords,
        source_views: sourceViews,
        freshness: { updated_at: view.updated_at, created_at: view.created_at },
        status: view.status,
        confidence: view.confidence,
        scope: view.scope ?? {},
      },
    });
    return;
  }
  out(`${view.view_type} ${view.id}`);
  out(`  title: ${view.title ?? "-"}`);
  out(`  compiler: ${view.compiler?.id ?? "-"} ${view.compiler?.mode ?? ""}`.trimEnd());
  out(`  status: ${view.status ?? "-"}`);
  out(`  source_records: ${(view.source_records ?? []).join(", ") || "-"}`);
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    out(`    record ${id}: ${record?.schema.name ?? "missing"} ${record?.content?.title ?? record?.content?.url ?? ""}`.trimEnd());
  }
  out(`  source_views: ${(view.source_views ?? []).join(", ") || "-"}`);
  for (const id of view.source_views ?? []) {
    const sourceView = store.getView(id);
    out(`    view ${id}: ${sourceView?.view_type ?? "missing"} ${sourceView?.title ?? ""}`.trimEnd());
  }
  out(`  metadata: ${JSON.stringify(view.metadata ?? {})}`);
}

function printViewSearch(query: string): void {
  const specs = searchViewSpecs(registry.list(), query);
  const views = filterViewsByQuery(store.listViews({ active_only: true, limit: 100 }), query).slice(0, 20);
  if (jsonOutput) {
    emitJson({ query, specs, views: views.map(viewSummary) });
    return;
  }
  out("Specs");
  printViewList(specs);
  out("");
  out("Stored views");
  if (!views.length) {
    out("  none");
    return;
  }
  for (const view of views) printStoredViewLine(view);
}

function upsertViewFromCli(args: string[]): void {
  const inputPath = required(args[0], "json_file_or_stdin");
  const actor = actorFromArgs(args);
  const raw = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
  const parsedJson = parseJson(raw, inputPath);
  if (!parsedJson.ok) {
    fail(parsedJson.error, "INVALID_JSON");
    return;
  }
  const parsed = ContextViewSchema.safeParse(parsedJson.value);
  if (!parsed.success) {
    fail(`Invalid ContextView: ${JSON.stringify(parsed.error.flatten())}`, "INVALID_VIEW");
    return;
  }
  const view = normalizeCliUpsertView(parsed.data, actor);
  const stored = store.upsertView(view);
  store.appendRuntimeEvent({
    event_type: "agent_surface.view_upserted",
    actor,
    status: "completed",
    subject_type: "view",
    subject_id: stored.id,
    related_records: stored.source_records,
    related_views: stored.source_views,
    plugin_id: stored.scope?.plugin_id,
    payload: {
      view_type: stored.view_type,
      command: currentCommand,
      created_or_updated_by: actor,
    },
  });
  if (jsonOutput) {
    emitJson({ view: viewSummary(stored), provenance: provenanceSummary(stored) });
    return;
  }
  out(`upserted ${stored.view_type} ${stored.id}`);
}

function forkViewFromCli(args: string[]): void {
  const sourceId = required(args[0], "view_id");
  const source = store.getView(sourceId);
  if (!source) {
    fail(`View not found: ${sourceId}`, "VIEW_NOT_FOUND");
    return;
  }
  const actor = actorFromArgs(args);
  const targetId = valueAfter(args, "--id") ?? forkedViewId(source.id);
  const viewType = valueAfter(args, "--view-type") ?? source.view_type;
  const title = valueAfter(args, "--title") ?? source.title;
  const summary = valueAfter(args, "--summary") ?? source.summary;
  const reason = valueAfter(args, "--reason") ?? "forked from CLI";
  const patch = patchFromArgs(args);
  const { created_at: _sourceCreatedAt, updated_at: _sourceUpdatedAt, ...sourceDraft } = source;
  const forked = normalizeCliEditedView({
    ...sourceDraft,
    id: targetId,
    view_type: viewType,
    title,
    summary,
    status: statusFromArgs(args) ?? "candidate",
    source_records: source.source_records ?? [],
    source_views: uniqueStrings([source.id, ...(source.source_views ?? [])]),
    compiler: {
      id: actor === "agent" ? "agent.fork_view" : "manual.fork_view",
      version: "1",
      mode: "deterministic",
    },
    content: applyObjectPatch(source.content ?? {}, patch?.content),
    metadata: applyObjectPatch({
      ...(source.metadata ?? {}),
      graph_op: "fork",
      forked_from: source.id,
      fork_reason: reason,
    }, patch?.metadata),
  }, actor, "fork");
  const parsed = ContextViewSchema.safeParse(forked);
  if (!parsed.success) {
    fail(`Invalid forked ContextView: ${JSON.stringify(parsed.error.flatten())}`, "INVALID_VIEW");
    return;
  }
  const stored = store.upsertView(parsed.data);
  appendAgentSurfaceViewEvent("agent_surface.view_forked", actor, stored, {
    source_view_id: source.id,
    reason,
    command: currentCommand,
  });
  emitViewMutationResult("forked", stored);
}

function updateViewFromCli(args: string[]): void {
  const id = required(args[0], "view_id");
  const existing = store.getView(id);
  if (!existing) {
    fail(`View not found: ${id}`, "VIEW_NOT_FOUND");
    return;
  }
  const actor = actorFromArgs(args);
  const patch = patchFromArgs(args);
  const replaceContent = args.includes("--replace-content");
  const replaceMetadata = args.includes("--replace-metadata");
  const updated = normalizeCliEditedView({
    ...existing,
    view_type: valueAfter(args, "--view-type") ?? existing.view_type,
    title: valueAfter(args, "--title") ?? existing.title,
    summary: valueAfter(args, "--summary") ?? existing.summary,
    status: statusFromArgs(args) ?? existing.status,
    source_records: mergeStringList(existing.source_records, valuesAfter(args, "--source-record")),
    source_views: mergeStringList(existing.source_views, valuesAfter(args, "--source-view")),
    content: replaceContent ? patch?.content ?? {} : applyObjectPatch(existing.content ?? {}, patch?.content),
    metadata: replaceMetadata
      ? applyObjectPatch({
        graph_op: "update",
        updated_from: existing.id,
      }, patch?.metadata)
      : applyObjectPatch({
        ...(existing.metadata ?? {}),
        graph_op: "update",
        updated_from: existing.id,
      }, patch?.metadata),
  }, actor, "update");
  const parsed = ContextViewSchema.safeParse(updated);
  if (!parsed.success) {
    fail(`Invalid updated ContextView: ${JSON.stringify(parsed.error.flatten())}`, "INVALID_VIEW");
    return;
  }
  const stored = store.upsertView(parsed.data);
  appendAgentSurfaceViewEvent("agent_surface.view_updated", actor, stored, {
    previous_updated_at: existing.updated_at,
    command: currentCommand,
  });
  emitViewMutationResult("updated", stored);
}

function deleteViewFromCli(args: string[]): void {
  const id = required(args[0], "view_id");
  const existing = store.getView(id);
  if (!existing) {
    fail(`View not found: ${id}`, "VIEW_NOT_FOUND");
    return;
  }
  const actor = actorFromArgs(args);
  const reason = valueAfter(args, "--reason") ?? "deleted from CLI";
  if (args.includes("--hard")) {
    const deleted = store.deleteView(id);
    if (!deleted) {
      fail(`View not found: ${id}`, "VIEW_NOT_FOUND");
      return;
    }
    store.appendRuntimeEvent({
      event_type: "agent_surface.view_deleted",
      actor,
      status: "completed",
      subject_type: "view",
      subject_id: id,
      related_records: existing.source_records,
      related_views: existing.source_views,
      plugin_id: existing.scope?.plugin_id,
      payload: {
        view_type: existing.view_type,
        hard: true,
        reason,
        command: currentCommand,
      },
    });
    if (jsonOutput) {
      emitJson({ deleted: true, hard: true, view: viewSummary(existing) });
      return;
    }
    out(`deleted ${existing.view_type} ${id}`);
    return;
  }
  const archived = store.upsertView(normalizeCliEditedView({
    ...existing,
    status: "archived",
    metadata: {
      ...(existing.metadata ?? {}),
      graph_op: "delete",
      delete_mode: "archive",
      delete_reason: reason,
    },
  }, actor, "delete"));
  appendAgentSurfaceViewEvent("agent_surface.view_deleted", actor, archived, {
    hard: false,
    reason,
    command: currentCommand,
  });
  if (jsonOutput) {
    emitJson({ deleted: true, hard: false, view: viewSummary(archived), provenance: provenanceSummary(archived) });
    return;
  }
  out(`archived ${archived.view_type} ${archived.id}`);
}

function printViewChildren(viewId: string, args: string[]): void {
  const root = store.getView(viewId);
  if (!root) {
    fail(`View not found: ${viewId}`, "VIEW_NOT_FOUND");
    return;
  }
  const limit = numberAfter(args, "--limit") ?? 50;
  const children = store.listViews({ source_view_id: viewId, limit, active_only: !args.includes("--all") });
  if (jsonOutput) {
    emitJson({ view: viewSummary(root), children: children.map(viewSummary) });
    return;
  }
  out(`${root.view_type} ${root.id}`);
  if (!children.length) {
    out("  children: none");
    return;
  }
  out("  children:");
  for (const view of children) printStoredViewLine(view);
}

async function handleScreenpipeCommand(args: string[]): Promise<void> {
  const subcommand = required(args[0], "screenpipe_command");
  const rest = args.slice(1);
  if (subcommand === "status") {
    printScreenpipeStatus(rest);
    return;
  }
  if (subcommand === "search") {
    printScreenpipeSearch(rest);
    return;
  }
  fail("unknown command", "UNKNOWN_COMMAND");
}

function printScreenpipeStatus(args: string[]): void {
  const screenpipeArgs = ["status", "--json", ...passthroughScreenpipeArgs(args, new Set(["--port", "--data-dir"]))];
  const result = runScreenpipeJson(screenpipeArgs);
  if (!result.ok) {
    fail(result.error, "SCREENPIPE_FAILED");
    return;
  }
  if (jsonOutput) {
    emitJson({ status: result.value, screenpipe_args: screenpipeArgs });
    return;
  }
  out(JSON.stringify(result.value, null, 2));
}

function printScreenpipeSearch(args: string[]): void {
  const write = args.includes("--write");
  const query = positionalArgs(args)[0];
  const allowedFlags = new Set([
    "--content-type",
    "--limit",
    "-n",
    "--offset",
    "--start",
    "--end",
    "--app",
    "--window",
    "--browser-url",
    "--frame-name",
    "--speaker",
    "--device-name",
    "--machine-id",
    "--min-length",
    "--max-length",
    "--max-content-length",
    "--data-dir",
  ]);
  const booleanFlags = new Set(["--focused", "--on-screen"]);
  const screenpipeArgs = [
    "search",
    ...passthroughScreenpipeArgs(args.filter(arg => arg !== "--write"), allowedFlags, booleanFlags),
    "--json",
    ...(query ? [query] : []),
  ];
  const result = runScreenpipeJsonLines(screenpipeArgs);
  if (!result.ok) {
    fail(result.error, "SCREENPIPE_FAILED");
    return;
  }
  const records = result.items.map((item, index) => normalizeScreenpipeResult(item, index, "screenpipe-cli", query));
  const written = write ? records.map(record => store.insertRecord(record)).map(record => record.id) : [];
  if (write) {
    store.appendRuntimeEvent({
      event_type: "agent_surface.screenpipe_search",
      actor: "agent",
      status: "completed",
      subject_type: "query",
      subject_id: `screenpipe:search:${Date.now()}`,
      related_records: written,
      payload: {
        command: currentCommand,
        screenpipe_args: screenpipeArgs,
        result_count: records.length,
        written_count: written.length,
        raw_media_stays_in_screenpipe: true,
      },
    });
  }
  if (jsonOutput) {
    emitJson({
      query,
      screenpipe_args: screenpipeArgs,
      count: records.length,
      written_records: written,
      records: records.map(recordSummary),
      raw_items: result.items,
    });
    return;
  }
  out(`screenpipe records: ${records.length}`);
  if (write) out(`written_records: ${written.join(", ") || "-"}`);
  for (const record of records.slice(0, 10)) {
    out(`  ${record.schema.name} ${record.id} ${record.content?.title ?? ""}`.trim());
  }
}

function handleMarkdownMemoryCommand(kind: "daily" | "profile", args: string[]): void {
  const subcommand = required(args[0], `memory_${kind}_command`);
  const rest = args.slice(1);
  if (subcommand === "show") {
    showMarkdownMemory(kind, rest);
    return;
  }
  if (subcommand === "write") {
    writeMarkdownMemory(kind, rest);
    return;
  }
  if (subcommand === "sync") {
    syncMarkdownMemory(kind, rest);
    return;
  }
  fail("unknown command", "UNKNOWN_COMMAND");
}

function showMarkdownMemory(kind: "daily" | "profile", args: string[]): void {
  const target = markdownMemoryTarget(kind, args);
  const markdown = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  const latest = store.listViews({ view_types: [target.view_type], active_only: true, limit: 20 })
    .find(view => view.content?.markdown_path === target.relative_path || view.id === target.view_id);
  if (jsonOutput) {
    emitJson({ ...target, exists: existsSync(target.path), markdown, view: latest ? viewSummary(latest) : null });
    return;
  }
  out(target.path);
  out(markdown || "(empty)");
}

function writeMarkdownMemory(kind: "daily" | "profile", args: string[]): void {
  const target = markdownMemoryTarget(kind, args);
  const from = valueAfter(args, "--from");
  const actor = actorFromArgs(args);
  const markdown = from ? readFileSync(from, "utf8") : readFileSync(0, "utf8");
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, markdown);
  const view = syncMarkdownMemoryView(target, markdown, actor);
  if (jsonOutput) {
    emitJson({ ...target, view: viewSummary(view), provenance: provenanceSummary(view) });
    return;
  }
  out(`wrote ${target.path}`);
  out(`synced ${view.view_type} ${view.id}`);
}

function syncMarkdownMemory(kind: "daily" | "profile", args: string[]): void {
  const target = markdownMemoryTarget(kind, args);
  if (!existsSync(target.path)) {
    fail(`Markdown memory file not found: ${target.path}`, "MEMORY_MARKDOWN_NOT_FOUND");
    return;
  }
  const view = syncMarkdownMemoryView(target, readFileSync(target.path, "utf8"), actorFromArgs(args));
  if (jsonOutput) {
    emitJson({ ...target, view: viewSummary(view), provenance: provenanceSummary(view) });
    return;
  }
  out(`synced ${view.view_type} ${view.id}`);
}

function syncMarkdownMemoryView(target: MarkdownMemoryTarget, markdown: string, actor: "user" | "agent"): StoredContextView {
  const view = store.upsertView({
    id: target.view_id,
    view_type: target.view_type,
    title: target.title,
    summary: firstNonHeadingLine(markdown),
    status: "accepted",
    compiler: {
      id: actor === "agent" ? `agent.${target.kind}_memory_markdown` : `manual.${target.kind}_memory_markdown`,
      version: "1",
      mode: "deterministic",
    },
    content: {
      date: target.date,
      markdown_path: target.relative_path,
      markdown,
      summary: firstNonHeadingLine(markdown),
    },
    stability: "long_term",
    privacy: { level: "private", retention: "normal", allow_external_llm: false, allow_external_reader: false },
    metadata: {
      markdown_backed: true,
      editable: true,
      actor,
      updated_via: "agent_surface_cli",
    },
  });
  store.appendRuntimeEvent({
    event_type: "agent_surface.memory_markdown_synced",
    actor,
    status: "completed",
    subject_type: "view",
    subject_id: view.id,
    related_views: [view.id],
    payload: {
      view_type: view.view_type,
      markdown_path: target.relative_path,
      command: currentCommand,
    },
  });
  return view;
}

type MarkdownMemoryTarget = {
  kind: "daily" | "profile";
  view_type: "memory.daily" | "memory.profile";
  view_id: string;
  title: string;
  relative_path: string;
  path: string;
  date: string;
};

const DURABLE_MEMORY_VIEW_TYPES = [
  "memory.daily",
  "memory.profile",
  "memory.preferences",
  "memory.workflow_patterns",
  "memory.skill_gaps",
  "memory.agent_collaboration_style",
  "project.memory",
  "agent.case_memory",
  "memory.surfacing_preference",
  "memory.output_edit_pattern",
  "memory.language.difficult_segments",
  "memory.project.patterns",
  "memory.routine_patterns",
];

function printMemoryList(): void {
  const views = store.listViews({ view_types: DURABLE_MEMORY_VIEW_TYPES, active_only: true, limit: 100 });
  if (jsonOutput) {
    emitJson({ memories: views.map(viewSummary) });
    return;
  }
  if (!views.length) {
    out("No durable memories found");
    return;
  }
  printTable(views.map(view => ({
    view_type: view.view_type,
    id: view.id,
    status: String(view.status ?? "-"),
    summary: String(view.content?.summary ?? view.content?.claim ?? view.summary ?? view.title ?? "").slice(0, 120),
  })), ["view_type", "id", "status", "summary"]);
}

function printMemoryCandidates(): void {
  const views = store.listViews({ view_types: ["memory.candidate"], active_only: true, limit: 100 });
  if (jsonOutput) {
    emitJson({ candidates: views.map(viewSummary) });
    return;
  }
  if (!views.length) {
    out("No active memory candidates found");
    return;
  }
  printTable(views.map(view => ({
    id: view.id,
    target: String(view.content?.target_view_type ?? "-"),
    status: String(view.content?.gate_status ?? view.status ?? "-"),
    claim: String(view.content?.claim ?? view.summary ?? "").slice(0, 120),
  })), ["id", "target", "status", "claim"]);
}

function printMemoryTrace(id: string): void {
  const view = store.getView(id);
  if (!view) {
    fail(`Memory view not found: ${id}`, "MEMORY_NOT_FOUND");
    return;
  }
  if (jsonOutput) {
    emitJson({
      memory: viewSummary(view),
      memory_kind: view.content?.memory_kind,
      target_view_type: view.content?.target_view_type ?? view.view_type,
      gate_status: view.content?.gate_status ?? view.status,
      durable_view_id: view.content?.durable_view_id,
      source_candidate_ids: Array.isArray(view.content?.source_candidate_ids) ? view.content.source_candidate_ids : [],
    });
    return;
  }
  printViewTrace(id);
  out(`  memory_kind: ${view.content?.memory_kind ?? "-"}`);
  out(`  target_view_type: ${view.content?.target_view_type ?? view.view_type}`);
  out(`  gate_status: ${view.content?.gate_status ?? view.status ?? "-"}`);
  out(`  durable_view_id: ${view.content?.durable_view_id ?? "-"}`);
  out(`  source_candidate_ids: ${Array.isArray(view.content?.source_candidate_ids) ? view.content.source_candidate_ids.join(", ") : "-"}`);
}

function rejectMemoryCandidate(id: string, reason: string): void {
  const candidate = store.getView(id);
  if (!candidate || candidate.view_type !== "memory.candidate") {
    fail(`Memory candidate not found: ${id}`, "MEMORY_CANDIDATE_NOT_FOUND");
    return;
  }
  const feedback = store.insertRecord({
    id: `feedback:memory-rejected:${Date.now()}:${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    schema: { name: "feedback.memory.rejected", version: 1 },
    source: { type: "application", connector: "mf.memory" },
    content: { title: "Memory candidate rejected", text: reason },
    relations: { related_to: [id] },
    payload: { candidate_id: id, reason },
    privacy: { level: "private", retention: "normal" },
  });
  const result = compileMemoryGateView({ candidates: [candidate], reject_ids: [id], rejection_reason: reason, write: true }, store);
  if (jsonOutput) {
    emitJson({
      candidate_id: id,
      feedback_id: feedback.id,
      decision: result.decisions[0]?.action ?? "none",
    });
    return;
  }
  out(`rejected ${id}`);
  out(`feedback ${feedback.id}`);
  out(`decision ${result.decisions[0]?.action ?? "none"}`);
}

function promoteMemoryCandidate(id: string): void {
  const candidate = store.getView(id);
  if (!candidate || candidate.view_type !== "memory.candidate") {
    fail(`Memory candidate not found: ${id}`, "MEMORY_CANDIDATE_NOT_FOUND");
    return;
  }
  const result = compileMemoryGateView({ candidates: [candidate], force_promote_ids: [id], write: true }, store);
  const decision = result.decisions[0];
  if (!decision || (decision.action !== "promote" && decision.action !== "merge")) {
    fail(`Memory candidate not promoted: ${id} (${decision && "reason" in decision ? decision.reason : "no decision"})`, "MEMORY_CANDIDATE_NOT_PROMOTED");
    return;
  }
  if (jsonOutput) {
    emitJson({
      candidate_id: id,
      action: decision.action,
      target: decision.action === "merge" ? decision.target_view_id : result.views[0]?.id ?? decision.target_view_type,
    });
    return;
  }
  out(`${decision.action} ${id}`);
  if (decision.action === "merge") out(`target ${decision.target_view_id}`);
  else out(`target ${result.views[0]?.id ?? decision.target_view_type}`);
}

function printStoredViewLine(view: StoredContextView): void {
  out(`  ${view.view_type} ${view.id} ${view.updated_at} ${view.title ?? ""}`.trim());
}

function recordSummary(record: StoredContextRecord): Record<string, unknown> {
  return {
    id: record.id,
    schema: record.schema.name,
    source: record.source.type,
    title: record.content?.title,
    url: record.content?.url,
    observed_at: record.time?.observed_at,
  };
}

function runScreenpipeJson(args: string[]): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const output = execFileSync("screenpipe", args, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    }).trim();
    return { ok: true, value: output ? JSON.parse(output) : {} };
  } catch (error) {
    return { ok: false, error: commandErrorMessage(error) };
  }
}

function runScreenpipeJsonLines(args: string[]): { ok: true; items: unknown[] } | { ok: false; error: string } {
  try {
    const output = execFileSync("screenpipe", args, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    }).trim();
    if (!output) return { ok: true, items: [] };
    return { ok: true, items: output.split(/\n+/).filter(Boolean).map(line => JSON.parse(line)) };
  } catch (error) {
    return { ok: false, error: commandErrorMessage(error) };
  }
}

function commandErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function passthroughScreenpipeArgs(args: string[], namedFlags: Set<string>, booleanFlags = new Set<string>()): string[] {
  const passthrough: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-") || arg === "--write") continue;
    if (booleanFlags.has(arg)) {
      passthrough.push(arg);
      continue;
    }
    if (namedFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        passthrough.push(arg);
        continue;
      }
      passthrough.push(arg, value);
      index += 1;
    }
  }
  return passthrough;
}

function positionalArgs(args: string[]): string[] {
  const valueFlags = new Set([
    "--content-type",
    "--limit",
    "-n",
    "--offset",
    "--start",
    "--end",
    "--app",
    "--window",
    "--browser-url",
    "--frame-name",
    "--speaker",
    "--device-name",
    "--machine-id",
    "--min-length",
    "--max-length",
    "--max-content-length",
    "--data-dir",
    "--port",
    "--from",
    "--date",
    "--actor",
  ]);
  const positions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positions.push(arg);
  }
  return positions;
}

function markdownMemoryTarget(kind: "daily" | "profile", args: string[]): MarkdownMemoryTarget {
  const date = valueAfter(args, "--date") ?? new Date().toISOString().slice(0, 10);
  const relativePath = kind === "daily" ? join("memory", "daily", `${date}.md`) : join("memory", "profile", "user.md");
  const root = process.env.INFO_MEMORY_ROOT ?? process.cwd();
  return {
    kind,
    view_type: kind === "daily" ? "memory.daily" : "memory.profile",
    view_id: kind === "daily" ? `memory:daily:${date}` : "memory:profile:user",
    title: kind === "daily" ? `Daily memory ${date}` : "Memory profile",
    relative_path: relativePath,
    path: join(root, relativePath),
    date,
  };
}

function firstNonHeadingLine(markdown: string): string | undefined {
  for (const line of markdown.split(/\r?\n/).map(item => item.trim())) {
    if (line && !line.startsWith("#")) return line.slice(0, 240);
  }
  return undefined;
}

function printHelp(): void {
  if (jsonOutput) {
    emitJson({
      usage: [
        "pnpm mf [--json] state",
        "pnpm mf [--json] view list",
        "pnpm mf [--json] view show <view_type>",
        "pnpm mf [--json] view json <view_type>",
        "pnpm mf [--json] view latest <view_type>",
        "pnpm mf [--json] view trace <view_id>",
        "pnpm mf [--json] view search <query>",
        "pnpm mf [--json] view upsert <json_file|-> [--actor agent|user]",
        "pnpm mf [--json] view fork <view_id> [--id <new_id>] [--view-type <type>] [--title <title>] [--patch <json_file|->] [--actor agent|user]",
        "pnpm mf [--json] view update <view_id> [--status candidate|accepted|archived|rejected] [--patch <json_file|->] [--actor agent|user]",
        "pnpm mf [--json] view delete <view_id> [--hard] [--reason <reason>] [--actor agent|user]",
        "pnpm mf [--json] view children <view_id> [--all] [--limit 50]",
        "pnpm mf [--json] processor list",
        "pnpm mf [--json] processor report",
        "pnpm mf [--json] processor run <processor_id> --record <record_id>",
        "pnpm mf [--json] processor run <processor_id> --view <view_id>",
        "pnpm mf [--json] task list [--refresh] [--limit 100]",
        "pnpm mf [--json] task queue [--limit 8]",
        "pnpm mf [--json] task process [--runtime local_mock|claude_code|acp_stdio] [--limit 8] [--dry-run]",
        "pnpm mf [--json] sensor screenpipe status",
        "pnpm mf [--json] sensor screenpipe search [query] [--write] [--focused] [--app <app>] [--browser-url <url>] [--window <title>] [--content-type <type>] [--speaker <speaker>] [--start <time>]",
        "pnpm mf [--json] memory daily show|write|sync [--date YYYY-MM-DD] [--from file] [--actor agent|user]",
        "pnpm mf [--json] memory profile show|write|sync [--from file] [--actor agent|user]",
        "pnpm mf [--json] memory list",
        "pnpm mf [--json] memory candidates",
        "pnpm mf [--json] memory trace <memory_id>",
        "pnpm mf [--json] memory reject <candidate_id> [reason]",
        "pnpm mf [--json] memory promote <candidate_id>",
      ],
    });
    return;
  }
  out(`Usage:
  pnpm mf [--json] state
  pnpm mf [--json] view list
  pnpm mf [--json] view show <view_type>
  pnpm mf [--json] view json <view_type>
  pnpm mf [--json] view latest <view_type>
  pnpm mf [--json] view trace <view_id>
  pnpm mf [--json] view search <query>
  pnpm mf [--json] view upsert <json_file|-> [--actor agent|user]
  pnpm mf [--json] view fork <view_id> [--id <new_id>] [--view-type <type>] [--title <title>] [--patch <json_file|->] [--actor agent|user]
  pnpm mf [--json] view update <view_id> [--status candidate|accepted|archived|rejected] [--patch <json_file|->] [--actor agent|user]
  pnpm mf [--json] view delete <view_id> [--hard] [--reason <reason>] [--actor agent|user]
  pnpm mf [--json] view children <view_id> [--all] [--limit 50]
  pnpm mf [--json] processor list
  pnpm mf [--json] processor report
  pnpm mf [--json] processor run <processor_id> --record <record_id>
  pnpm mf [--json] processor run <processor_id> --view <view_id>
  pnpm mf [--json] task list [--refresh] [--limit 100]
  pnpm mf [--json] task queue [--limit 8]
  pnpm mf [--json] task process [--runtime local_mock|claude_code|acp_stdio] [--limit 8] [--dry-run]
  pnpm mf [--json] sensor screenpipe status
  pnpm mf [--json] sensor screenpipe search [query] [--write] [--focused] [--app <app>] [--browser-url <url>] [--window <title>] [--content-type <type>] [--speaker <speaker>] [--start <time>]
  pnpm mf [--json] memory daily show|write|sync [--date YYYY-MM-DD] [--from file] [--actor agent|user]
  pnpm mf [--json] memory profile show|write|sync [--from file] [--actor agent|user]
  pnpm mf [--json] memory list
  pnpm mf [--json] memory candidates
  pnpm mf [--json] memory trace <memory_id>
  pnpm mf [--json] memory reject <candidate_id> [reason]
  pnpm mf [--json] memory promote <candidate_id>`);
}

function parseGlobalArgs(argv: string[]): { json: boolean; argv: string[] } {
  return {
    json: argv.includes("--json"),
    argv: argv.filter(arg => arg !== "--json"),
  };
}

function viewSummary(view: StoredContextView): Record<string, unknown> {
  return {
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    status: view.status,
    stability: view.stability,
    updated_at: view.updated_at,
    created_at: view.created_at,
    source_records: view.source_records ?? [],
    source_views: view.source_views ?? [],
    producer: view.compiler?.id,
    scope: view.scope ?? {},
    content: view.content ?? {},
  };
}

function provenanceSummary(view: StoredContextView): Record<string, unknown> {
  return {
    producer: view.compiler?.id,
    source_record_count: (view.source_records ?? []).length,
    source_view_count: (view.source_views ?? []).length,
    freshness: { updated_at: view.updated_at, created_at: view.created_at },
    status: view.status,
    scope: view.scope ?? {},
  };
}

function normalizeCliUpsertView(view: ContextView, actor: "user" | "agent"): ContextView {
  return {
    ...view,
    compiler: view.compiler ?? {
      id: actor === "agent" ? "agent.create_view" : "manual.create_view",
      version: "1",
      mode: "deterministic",
    },
    metadata: {
      ...(view.metadata ?? {}),
      created_via: actor === "agent" ? "agent_surface_cli" : "manual_cli",
      actor,
    },
  };
}

function normalizeCliEditedView(view: ContextView, actor: "user" | "agent", op: "fork" | "update" | "delete"): ContextView {
  return {
    ...view,
    compiler: view.compiler ?? {
      id: actor === "agent" ? `agent.${op}_view` : `manual.${op}_view`,
      version: "1",
      mode: "deterministic",
    },
    metadata: {
      ...(view.metadata ?? {}),
      edited_via: actor === "agent" ? "agent_surface_cli" : "manual_cli",
      actor,
    },
  };
}

function appendAgentSurfaceViewEvent(eventType: string, actor: "user" | "agent", view: StoredContextView, payload: Record<string, unknown>): void {
  store.appendRuntimeEvent({
    event_type: eventType,
    actor,
    status: "completed",
    subject_type: "view",
    subject_id: view.id,
    related_records: view.source_records,
    related_views: view.source_views,
    plugin_id: view.scope?.plugin_id,
    payload: {
      view_type: view.view_type,
      ...payload,
    },
  });
}

function emitViewMutationResult(verb: string, view: StoredContextView): void {
  if (jsonOutput) {
    emitJson({ view: viewSummary(view), provenance: provenanceSummary(view) });
    return;
  }
  out(`${verb} ${view.view_type} ${view.id}`);
}

function forkedViewId(sourceId: string): string {
  return `${sourceId}:fork:${Date.now().toString(36)}`;
}

function statusFromArgs(args: string[]): ContextView["status"] | undefined {
  const value = valueAfter(args, "--status");
  if (!value) return undefined;
  if (value === "candidate" || value === "accepted" || value === "archived" || value === "rejected") return value;
  throw new Error("--status must be candidate, accepted, archived, or rejected");
}

function patchFromArgs(args: string[]): Record<string, any> | undefined {
  const input = valueAfter(args, "--patch");
  if (!input) return undefined;
  const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  const parsed = parseJson(raw, input);
  if (!parsed.ok) throw new Error(parsed.error);
  if (!isPlainObject(parsed.value)) throw new Error("--patch must be a JSON object");
  return parsed.value as Record<string, any>;
}

function applyObjectPatch(base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) throw new Error("patch content/metadata must be JSON objects");
  return deepMerge(base, patch as Record<string, unknown>);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeStringList(existing: string[] | undefined, additions: string[]): string[] | undefined {
  if (!additions.length) return existing;
  return uniqueStrings([...(existing ?? []), ...additions]);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function actorFromArgs(args: string[]): "user" | "agent" {
  const value = valueAfter(args, "--actor") ?? "agent";
  if (value === "agent" || value === "user") return value;
  throw new Error("--actor must be agent or user");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function valuesAfter(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parseJson(raw: string, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON from ${label}: ${message}` };
  }
}

function emitJson<T>(data: T): void {
  const envelope: CliEnvelope<T> = { ok: true, command: currentCommand, data };
  out(JSON.stringify(envelope, null, 2));
}

function fail(message: string, code = "ERROR"): void {
  if (jsonOutput) {
    const envelope: CliErrorEnvelope = { ok: false, command: currentCommand, error: { code, message } };
    err(JSON.stringify(envelope, null, 2));
  } else {
    err(message);
  }
  process.exitCode = 1;
}

function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
  if (!rows.length) {
    out("  none");
    return;
  }
  const widths = Object.fromEntries(columns.map(column => [
    column,
    Math.max(column.length, ...rows.map(row => String(row[column] ?? "").length)),
  ]));
  out(columns.map(column => column.padEnd(widths[column])).join("  "));
  out(columns.map(column => "-".repeat(widths[column])).join("  "));
  for (const row of rows) {
    out(columns.map(column => String(row[column] ?? "").padEnd(widths[column])).join("  "));
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function out(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function err(message = ""): void {
  process.stderr.write(`${message}\n`);
}

main(process.argv.slice(2)).catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});

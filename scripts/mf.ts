import { ContextStore, filterViewsByQuery, type StoredContextView } from "@info/core";
import { builtinViewSpecs, createViewRegistry, searchViewSpecs, type ViewSpec } from "@info/view-system";
import { compileMemoryGate as compileMemoryGateView } from "@info/views";

const registry = createViewRegistry(builtinViewSpecs());
const store = new ContextStore();

async function main(argv: string[]): Promise<void> {
  const [area, command, ...rest] = argv;
  if (area !== "view") {
    if (area === "memory") {
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
    printHelp();
    process.exitCode = 1;
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

  printHelp();
}

function printViewList(specs: ViewSpec[]): void {
  const rows = specs.map(spec => ({
    view_type: spec.view_type,
    lifecycle: spec.lifecycle,
    producers: (spec.producers ?? []).map(producer => producer.id).join(",") || "-",
    purpose: spec.purpose,
  }));
  printTable(rows, ["view_type", "lifecycle", "producers", "purpose"]);
}

function printViewShow(viewType: string): void {
  const spec = registry.get(viewType);
  const latest = store.listViews({ view_types: [viewType], active_only: true, limit: 5 });

  if (!spec) {
    out(`View spec not found: ${viewType}`);
  } else {
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
  if (!latest.length) {
    out(`No active views found for ${viewType}`);
    return;
  }
  for (const view of latest) printStoredViewLine(view);
}

function printViewJson(viewType: string): void {
  const spec = registry.get(viewType);
  const latest = store.listViews({ view_types: [viewType], active_only: true, limit: 5 });
  out(JSON.stringify({ spec, latest }, null, 2));
}

function printViewTrace(viewId: string): void {
  const view = store.getView(viewId);
  if (!view) {
    err(`View not found: ${viewId}`);
    process.exitCode = 1;
    return;
  }
  out(`${view.view_type} ${view.id}`);
  out(`  title: ${view.title ?? "-"}`);
  out(`  compiler: ${view.compiler?.id ?? "-"} ${view.compiler?.mode ?? ""}`.trimEnd());
  out(`  confidence: ${view.confidence ?? "-"}`);
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

const DURABLE_MEMORY_VIEW_TYPES = [
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
  if (!views.length) {
    out("No durable memories found");
    return;
  }
  printTable(views.map(view => ({
    view_type: view.view_type,
    id: view.id,
    confidence: String(view.confidence ?? "-"),
    claim: String(view.content?.claim ?? view.summary ?? view.title ?? "").slice(0, 120),
  })), ["view_type", "id", "confidence", "claim"]);
}

function printMemoryCandidates(): void {
  const views = store.listViews({ view_types: ["memory.candidate"], active_only: true, limit: 100 });
  if (!views.length) {
    out("No active memory candidates found");
    return;
  }
  printTable(views.map(view => ({
    id: view.id,
    target: String(view.content?.target_view_type ?? "-"),
    confidence: String(view.content?.confidence ?? view.confidence ?? "-"),
    status: String(view.content?.gate_status ?? view.status ?? "-"),
    claim: String(view.content?.claim ?? view.summary ?? "").slice(0, 120),
  })), ["id", "target", "confidence", "status", "claim"]);
}

function printMemoryTrace(id: string): void {
  const view = store.getView(id);
  if (!view) {
    err(`Memory view not found: ${id}`);
    process.exitCode = 1;
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
    err(`Memory candidate not found: ${id}`);
    process.exitCode = 1;
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
  out(`rejected ${id}`);
  out(`feedback ${feedback.id}`);
  out(`decision ${result.decisions[0]?.action ?? "none"}`);
}

function promoteMemoryCandidate(id: string): void {
  const candidate = store.getView(id);
  if (!candidate || candidate.view_type !== "memory.candidate") {
    err(`Memory candidate not found: ${id}`);
    process.exitCode = 1;
    return;
  }
  const result = compileMemoryGateView({ candidates: [candidate], force_promote_ids: [id], write: true }, store);
  const decision = result.decisions[0];
  if (!decision || (decision.action !== "promote" && decision.action !== "merge")) {
    err(`Memory candidate not promoted: ${id} (${decision && "reason" in decision ? decision.reason : "no decision"})`);
    process.exitCode = 1;
    return;
  }
  out(`${decision.action} ${id}`);
  if (decision.action === "merge") out(`target ${decision.target_view_id}`);
  else out(`target ${result.views[0]?.id ?? decision.target_view_type}`);
}

function printStoredViewLine(view: StoredContextView): void {
  out(`  ${view.view_type} ${view.id} ${view.updated_at} ${view.title ?? ""}`.trim());
}

function printHelp(): void {
  out(`Usage:
  pnpm mf view list
  pnpm mf view show <view_type>
  pnpm mf view json <view_type>
  pnpm mf view latest <view_type>
  pnpm mf view trace <view_id>
  pnpm mf view search <query>
  pnpm mf memory list
  pnpm mf memory candidates
  pnpm mf memory trace <memory_id>
  pnpm mf memory reject <candidate_id> [reason]
  pnpm mf memory promote <candidate_id>`);
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
  err(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

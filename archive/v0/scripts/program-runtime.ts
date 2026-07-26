import { ContextStore } from "@info/core";
import { listDefaultPrograms } from "@info/programs/registry.js";
import { signalFromRecord, signalFromView } from "@info/programs/signals.js";
import { III_PROGRAM_FUNCTIONS, InProcessIiiRuntimeClient, registerInfoIiiRuntime } from "@info/iii-runtime";

const argv = process.argv.slice(2).filter((arg, index, all) => !(arg === "--" && index === 0));
const command = argv[0] ?? "list";
const store = new ContextStore();

function arg(name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

if (command === "list") {
  console.log(JSON.stringify({ ok: true, programs: listDefaultPrograms() }, null, 2));
} else if (command === "signal") {
  const recordId = arg("--record");
  const viewId = arg("--view");
  if (recordId) {
    const record = store.getRecord(recordId);
    if (!record) throw new Error(`record not found: ${recordId}`);
    console.log(JSON.stringify({ ok: true, signal: signalFromRecord(record) }, null, 2));
  } else if (viewId) {
    const view = store.getView(viewId);
    if (!view) throw new Error(`view not found: ${viewId}`);
    console.log(JSON.stringify({ ok: true, signal: signalFromView(view) }, null, 2));
  } else {
    const recent = store.recent(1)[0];
    if (!recent) throw new Error("no recent records");
    console.log(JSON.stringify({ ok: true, signal: signalFromRecord(recent) }, null, 2));
  }
} else if (command === "process") {
  const recordId = arg("--record");
  const viewId = arg("--view");
  const dryRun = argv.includes("--dry-run");
  const maxPrograms = arg("--max-programs") ? Number(arg("--max-programs")) : undefined;
  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-program-cli" });
  if (recordId) {
    const record = store.getRecord(recordId);
    if (!record) throw new Error(`record not found: ${recordId}`);
    const response = await iii.trigger({
      function_id: III_PROGRAM_FUNCTIONS.processRecord,
      payload: { record_id: record.id, dry_run: dryRun, max_programs: maxPrograms },
    }) as { result?: unknown };
    console.log(JSON.stringify(response.result ?? response, null, 2));
  } else if (viewId) {
    const view = store.getView(viewId);
    if (!view) throw new Error(`view not found: ${viewId}`);
    const response = await iii.trigger({
      function_id: III_PROGRAM_FUNCTIONS.processView,
      payload: { view_id: view.id, dry_run: dryRun, max_programs: maxPrograms },
    }) as { result?: unknown };
    console.log(JSON.stringify(response.result ?? response, null, 2));
  } else {
    const recent = store.recent(1)[0];
    if (!recent) throw new Error("no recent records");
    const response = await iii.trigger({
      function_id: III_PROGRAM_FUNCTIONS.processRecord,
      payload: { record_id: recent.id, dry_run: dryRun, max_programs: maxPrograms },
    }) as { result?: unknown };
    console.log(JSON.stringify(response.result ?? response, null, 2));
  }
} else {
  throw new Error(`unknown command: ${command}`);
}

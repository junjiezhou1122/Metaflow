import { ContextStore } from "@info/core";
import { createDefaultProgramRuntime, listDefaultPrograms } from "@info/programs/registry.js";
import { signalFromRecord, signalFromView } from "@info/programs/signals.js";

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
  const runtime = createDefaultProgramRuntime();
  const recordId = arg("--record");
  const viewId = arg("--view");
  const dryRun = argv.includes("--dry-run");
  const maxPrograms = arg("--max-programs") ? Number(arg("--max-programs")) : undefined;
  if (recordId) {
    const record = store.getRecord(recordId);
    if (!record) throw new Error(`record not found: ${recordId}`);
    console.log(JSON.stringify(await runtime.processObject(record, { dry_run: dryRun, max_programs: maxPrograms }), null, 2));
  } else if (viewId) {
    const view = store.getView(viewId);
    if (!view) throw new Error(`view not found: ${viewId}`);
    console.log(JSON.stringify(await runtime.processObject(view, { dry_run: dryRun, max_programs: maxPrograms }), null, 2));
  } else {
    const recent = store.recent(1)[0];
    if (!recent) throw new Error("no recent records");
    console.log(JSON.stringify(await runtime.processObject(recent, { dry_run: dryRun, max_programs: maxPrograms }), null, 2));
  }
} else {
  throw new Error(`unknown command: ${command}`);
}

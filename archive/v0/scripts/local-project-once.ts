import { ContextStore } from "@info/core";
import { buildLocalProjectSnapshotRecord } from "@info/sensors";

const cwd = process.argv[2] ?? process.cwd();
const store = new ContextStore();
const record = store.insertRecord(buildLocalProjectSnapshotRecord({
  cwd,
  acquisitionMode: "manual",
  actor: "user",
  reason: "local project snapshot",
}));

console.log(JSON.stringify({ ok: true, id: record.id, path: record.content?.path }, null, 2));

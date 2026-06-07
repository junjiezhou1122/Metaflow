import { activeThreadId, interpretThread } from "@info/views/threads/thread-interpreter.js";

const argv = process.argv.slice(2).filter(arg => arg !== "--");
const target = argv[0] ?? "active";
const dryRun = argv.includes("--dry-run");
const noUpdate = argv.includes("--no-update");

const threadId = target === "active" ? activeThreadId() : target;
if (!threadId) {
  console.error(JSON.stringify({ ok: false, error: "no active thread; pass a thread_id" }, null, 2));
  process.exit(1);
}

const result = await interpretThread({
  thread_id: threadId,
  write: !dryRun,
  update_thread: !dryRun && !noUpdate,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;


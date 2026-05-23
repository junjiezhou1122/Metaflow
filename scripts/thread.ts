import { ContextStore } from "../src/store.js";
import { persistThreadEvidenceMap } from "../src/thread-evidence.js";
import { mergeThreads, splitThread } from "../src/thread-ops.js";

const store = new ContextStore();
const [cmd, id, ...rest] = process.argv.slice(2).filter(arg => arg !== "--");

function usage() {
  console.log(`usage:
  pnpm run thread -- list [status]
  pnpm run thread -- accept <thread_id> [new title]
  pnpm run thread -- reject <thread_id>
  pnpm run thread -- rename <thread_id> <new title>
  pnpm run thread -- evidence <thread_id>
  pnpm run thread -- evidence active
  pnpm run thread -- evidence:write <thread_id>
  pnpm run thread -- merge <target_id> <source_id...> [--title New title]
  pnpm run thread -- split <thread_id> <evidence_id...> [--title New title]
`);
}

if (!cmd || cmd === "help") usage();
else if (cmd === "list") {
  const status = id as any;
  console.log(JSON.stringify({ ok: true, threads: store.listWorkThreads(status) }, null, 2));
} else if (cmd === "accept" && id) {
  const title = rest.join(" ") || undefined;
  console.log(JSON.stringify({ ok: true, thread: store.updateWorkThreadStatus(id, "accepted", title) }, null, 2));
} else if (cmd === "reject" && id) {
  console.log(JSON.stringify({ ok: true, thread: store.updateWorkThreadStatus(id, "rejected") }, null, 2));
} else if (cmd === "rename" && id && rest.length) {
  const thread = store.getWorkThread(id);
  if (!thread) console.log(JSON.stringify({ ok: false, error: "thread not found" }, null, 2));
  else {
    const renamed = store.upsertWorkThread({ ...thread, title: rest.join(" ") });
    syncActiveIfNeeded(renamed);
    console.log(JSON.stringify({ ok: true, thread: renamed }, null, 2));
  }
} else if ((cmd === "evidence" || cmd === "evidence:write") && id) {
  const threadId = id === "active" ? activeThreadId() : id;
  if (!threadId) {
    console.log(JSON.stringify({ ok: false, error: "no active thread" }, null, 2));
  } else if (cmd === "evidence:write") {
    console.log(JSON.stringify(persistThreadEvidenceMap(threadId, store), null, 2));
  } else {
    const thread = store.getWorkThread(threadId);
    if (!thread) console.log(JSON.stringify({ ok: false, error: "thread not found", threadId }, null, 2));
    else {
      const existing = thread.metadata?.evidence_map;
      if (existing) console.log(JSON.stringify({ ok: true, evidence_map: existing }, null, 2));
      else console.log(JSON.stringify(persistThreadEvidenceMap(threadId, store), null, 2));
    }
  }
} else if (cmd === "merge" && id && rest.length) {
  const titleIndex = rest.indexOf("--title");
  const title = titleIndex >= 0 ? rest.slice(titleIndex + 1).join(" ") : undefined;
  const sources = titleIndex >= 0 ? rest.slice(0, titleIndex) : rest;
  console.log(JSON.stringify(mergeThreads(id, sources, { title }, store), null, 2));
} else if (cmd === "split" && id && rest.length) {
  const titleIndex = rest.indexOf("--title");
  const title = titleIndex >= 0 ? rest.slice(titleIndex + 1).join(" ") : undefined;
  const evidenceIds = titleIndex >= 0 ? rest.slice(0, titleIndex) : rest;
  console.log(JSON.stringify(splitThread(id, evidenceIds, { title }, store), null, 2));
} else {
  usage();
  process.exitCode = 1;
}

function activeThreadId(): string | undefined {
  const active = store.getRuntimeState("active_thread")?.value;
  return typeof active?.thread_id === "string" ? active.thread_id : undefined;
}

function syncActiveIfNeeded(thread: any) {
  const active = store.getRuntimeState("active_thread")?.value;
  if (active?.thread_id !== thread.id) return;
  store.setRuntimeState("active_thread", { ...active, title: thread.title, display_title: thread.metadata?.display_title ?? active?.display_title });
}

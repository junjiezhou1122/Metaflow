import { ContextStore } from "@info/core";
import { compileProjectWorkEpisodeForThread } from "@info/views/timeline/episode-summary.js";

const store = new ContextStore();
const argv = process.argv.slice(2).filter(arg => arg !== "--");
const threadId = argv[0] ?? process.env.THREAD_ID;
const write = argv.includes("--write");
if (!threadId) {
  console.error("usage: pnpm run episode:summary -- <thread_id> [--write]");
  process.exit(1);
}

const result = compileProjectWorkEpisodeForThread(threadId, { write, store });
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));

import { ContextStore } from "@info/core";
import { aiSessionRefToRecord, locateAiSessions, type AiSessionTool } from "../packages/connectors/ai-sessions/index.js";

const args = process.argv.slice(2).filter(arg => arg !== "--");
const write = args.includes("--write");
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const projectPath = argValue("--project") ?? process.env.AI_SESSION_PROJECT ?? process.cwd();
const minutes = Number(argValue("--minutes") ?? process.env.AI_SESSION_MINUTES ?? 240);
const start_time = argValue("--start") ?? process.env.AI_SESSION_START_TIME;
const end_time = argValue("--end") ?? process.env.AI_SESSION_END_TIME;
const toolsRaw = (argValue("--tools") ?? process.env.AI_SESSION_TOOLS ?? "codex,claude-code").split(",").map(s => s.trim()).filter(Boolean) as AiSessionTool[];
const include_snippets = args.includes("--snippets") || process.env.AI_SESSION_SNIPPETS === "1";
const limit = Number(argValue("--limit") ?? process.env.AI_SESSION_LIMIT ?? 12);

const result = locateAiSessions({ project_path: projectPath, minutes, start_time, end_time, tools: toolsRaw, include_snippets, limit });
const written: string[] = [];
if (write) {
  const store = new ContextStore();
  for (const session of result.sessions) {
    written.push(store.insertRecord(aiSessionRefToRecord(session)).id);
  }
}

console.log(JSON.stringify({ ...result, written }, null, 2));

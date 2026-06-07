import { ContextStore } from "@info/core";
import { fetchScreenpipeRecords } from "@info/sensors";
import type { ContextPackRequest } from "@info/core";

const store = new ContextStore();
const req: ContextPackRequest = {
  goal: process.env.CONTEXT_PACK_GOAL ?? "继续设计 personal context runtime，并融合 Screenpipe perception evidence",
  scope: process.env.CONTEXT_PACK_PROJECT ? { project: process.env.CONTEXT_PACK_PROJECT } : undefined,
  limit: Number(process.env.CONTEXT_PACK_LIMIT ?? 20),
  token_budget: Number(process.env.CONTEXT_PACK_TOKEN_BUDGET ?? 4000),
  time_window: { minutes: Number(process.env.CONTEXT_PACK_MINUTES ?? 240) },
  include_screenpipe: process.env.CONTEXT_PACK_SCREENPIPE === "1",
  include_ai_sessions: process.env.CONTEXT_PACK_AI_SESSIONS === "1",
  ai_sessions: {
    tools: (process.env.AI_SESSION_TOOLS?.split(",").map(x => x.trim()).filter(Boolean) as any) ?? ["codex", "claude-code"],
    limit: Number(process.env.AI_SESSION_LIMIT ?? 8),
    snippets: process.env.AI_SESSION_SNIPPETS === "1",
  },
  screenpipe: {
    content_type: process.env.SCREENPIPE_CONTENT_TYPE ?? "all",
    limit: Number(process.env.SCREENPIPE_LIMIT ?? 8),
  },
};

const extraRecords = [];
const diagnostics: Record<string, unknown> = {};
if (req.include_screenpipe) {
  const screenpipe = await fetchScreenpipeRecords({
    ...req.screenpipe,
    q: req.screenpipe?.q ?? req.goal,
    start_time: req.time_window?.start_time,
    end_time: req.time_window?.end_time,
  });
  diagnostics.screenpipe = { ok: screenpipe.ok, url: screenpipe.url, query: screenpipe.query, count: screenpipe.records.length, error: screenpipe.error };
  extraRecords.push(...screenpipe.records);
}

if (req.include_ai_sessions) {
  const { aiSessionRefToRecord, locateAiSessions } = await import("@info/sensors");
  const located = locateAiSessions({
    project_path: process.env.AI_SESSION_PROJECT ?? process.cwd(),
    start_time: req.time_window?.start_time,
    end_time: req.time_window?.end_time,
    minutes: req.time_window?.minutes,
    tools: req.ai_sessions?.tools,
    limit: req.ai_sessions?.limit,
    include_snippets: req.ai_sessions?.snippets,
  });
  diagnostics.ai_sessions = { count: located.sessions.length, time_window: located.time_window, diagnostics: located.diagnostics };
  extraRecords.push(...located.sessions.map(aiSessionRefToRecord));
}

const pack = store.buildPack(req, extraRecords, diagnostics);
console.log(pack.markdown);

import { ContextStore } from "@info/core";

const store = new ContextStore();
const record = store.insertRecord({
  schema: { name: "observation.agent_discovery", version: 1 },
  source: { type: "agent", id: "substack-trend-agent", connector: "example" },
  scope: { project: "personal-context-system" },
  content: {
    title: "Example agent-discovered article",
    url: "https://example.com/substack/p/personal-ai-memory",
    text: "An agent-discovered candidate article about personal AI memory and context systems.",
  },
  acquisition: {
    mode: "agent",
    actor: "agent",
    task_id: `trend-scan-${new Date().toISOString().slice(0, 10)}`,
    query: "trending Substack personal AI memory context system",
    reason: "related to the active design goal",
  },
  signal: { importance: 0.35, confidence: 0.7, status: "candidate" },
  privacy: { level: "public", retention: "normal", allow_embedding: true, allow_llm_summary: true },
  payload: { platform: "substack", rank: 1, user_confirmed: false },
});
console.log(JSON.stringify({ ok: true, id: record.id }, null, 2));

import { ContextStore } from "../src/core/store.js";

const store = new ContextStore();

store.registerConnector({
  id: "tweet-save-agent",
  name: "Tweet Save Agent",
  type: "agent",
  version: 1,
  description: "Agent-driven connector that saves useful public tweets/posts into context with provenance and confidence.",
  schemas_produced: [{ name: "observation.social_post_saved", version: 1 }],
  default_privacy: {
    level: "public",
    retention: "normal",
    allow_embedding: true,
    allow_llm_summary: true,
    allow_external_reader: true,
    allow_external_llm: false,
  },
  permissions: {
    allow_network: true,
    allow_external_reader: true,
    allow_external_llm: false,
    max_privacy_level: "public",
  },
});

const record = store.insertRecord({
  schema: { name: "observation.social_post_saved", version: 1 },
  source: { type: "social", id: "example-post-001", connector: "tweet-save-agent" },
  scope: { project: "personal-context-runtime", domain: "x.com" },
  content: {
    title: "Example saved post about personal AI memory",
    url: "https://x.com/example/status/001",
    text: "A public post discussing personal AI memory, local context capture, provenance, and plugin ecosystems.",
  },
  acquisition: {
    mode: "agent",
    actor: "agent",
    task_id: `tweet-save-${new Date().toISOString().slice(0, 10)}`,
    reason: "Relevant to active work thread: personal-context-runtime",
    query: "personal AI memory context runtime plugin ecosystem",
  },
  signal: { importance: 0.6, confidence: 0.75, status: "candidate" },
  privacy: {
    level: "public",
    retention: "normal",
    allow_embedding: true,
    allow_llm_summary: true,
    allow_external_reader: true,
    allow_external_llm: false,
  },
  relations: {
    thread_memberships: [{
      thread_id: "personal-context-runtime",
      confidence: 0.72,
      reasons: ["agent search goal", "keyword overlap", "active design discussion"],
    }],
  },
  memory: { kind: "observation", stability: "project" },
  payload: {
    platform: "x",
    author: "example",
    post_id: "001",
    saved_by_agent: true,
    user_confirmed: false,
    topics: ["personal-ai", "memory", "context-runtime", "plugins"],
  },
});

console.log(JSON.stringify({ ok: true, id: record.id }, null, 2));

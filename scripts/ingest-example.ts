import { ContextStore } from "../src/core/store.js";

const store = new ContextStore();
const record = store.insertRecord({
  schema: { name: "observation.browser_page", version: 1 },
  source: { type: "browser", connector: "example" },
  scope: { project: "personal-context-system", domain: "www.wisme.ai" },
  content: {
    title: "Wisme.ai",
    url: "https://www.wisme.ai/",
    text: "AI personal knowledge base that captures browsing context, builds digests, and supports research agents.",
  },
  acquisition: { mode: "manual", actor: "user", reason: "initial smoke test" },
  signal: { importance: 0.8, confidence: 0.9, status: "accepted" },
  privacy: { level: "public", retention: "normal", allow_embedding: true, allow_llm_summary: true },
  payload: { dwell_seconds: 180, scroll_depth: 0.82 },
});
console.log(record);

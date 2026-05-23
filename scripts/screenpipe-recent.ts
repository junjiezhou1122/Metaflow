import { ContextStore } from "../src/core/store.js";
import { fetchScreenpipeRecords } from "../src/connectors/screenpipe.js";

const store = new ContextStore();
const screenpipeUrl = process.env.SCREENPIPE_URL ?? "http://localhost:3030";
const limit = Number(process.argv[2] ?? process.env.SCREENPIPE_LIMIT ?? 20);

store.registerConnector({
  id: "screenpipe-local-api",
  name: "Screenpipe Local API",
  type: "ambient",
  version: 1,
  description: "Imports references and selected text snippets from Screenpipe's local perception API instead of duplicating raw media.",
  schemas_produced: [
    { name: "observation.screenpipe_activity", version: 1 },
    { name: "derived.screenpipe_activity_summary", version: 1 },
  ],
  default_privacy: {
    level: "private",
    retention: "normal",
    allow_embedding: false,
    allow_llm_summary: false,
    allow_external_reader: false,
    allow_external_llm: false,
  },
  permissions: {
    allow_network: false,
    allow_external_reader: false,
    allow_external_llm: false,
    max_privacy_level: "private",
  },
  config: { api_url: screenpipeUrl },
});

const result = await fetchScreenpipeRecords({
  url: screenpipeUrl,
  limit,
  content_type: process.env.SCREENPIPE_CONTENT_TYPE ?? "all",
  q: process.env.SCREENPIPE_QUERY,
  start_time: process.env.SCREENPIPE_START_TIME,
  end_time: process.env.SCREENPIPE_END_TIME,
  app_name: process.env.SCREENPIPE_APP_NAME,
  window_name: process.env.SCREENPIPE_WINDOW_NAME,
  browser_url: process.env.SCREENPIPE_BROWSER_URL,
});

if (!result.ok) {
  console.error(JSON.stringify({ ok: false, screenpipe: { url: result.url, query: result.query }, error: result.error }, null, 2));
  process.exit(1);
}

const records = result.records.map(record => store.insertRecord(record));
console.log(JSON.stringify({
  ok: true,
  screenpipe: { url: result.url, query: result.query },
  imported: records.length,
  ids: records.map(r => r.id),
}, null, 2));

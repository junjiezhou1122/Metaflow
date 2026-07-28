import { parentPort } from "node:worker_threads";

parentPort?.postMessage({
  status: "succeeded",
  fragments: [
    {
      kind: "field",
      location: { kind: "json_pointer", path: "/representation/value/first" },
      content: { kind: "text", text: "first" },
      metadata: {},
    },
    {
      kind: "field",
      location: { kind: "json_pointer", path: "/representation/value/second" },
      content: { kind: "text", text: "second" },
      metadata: {},
    },
  ],
});

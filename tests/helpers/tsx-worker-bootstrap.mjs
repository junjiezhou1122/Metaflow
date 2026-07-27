import { workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

if (typeof workerData?.typescript_entry !== "string") {
  throw new TypeError("TypeScript Worker bootstrap requires typescript_entry");
}

await tsImport(workerData.typescript_entry, import.meta.url);

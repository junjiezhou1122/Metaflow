import { parentPort, workerData } from "node:worker_threads";
import { SqliteViewRepository } from "@info/storage-sqlite";
import type { ViewDraft } from "@info/view";

type WriterData = {
  path: string;
  draft: ViewDraft;
  start: SharedArrayBuffer;
};

const port = parentPort;
if (!port) throw new Error("View Store writer must run in a worker thread");
const data = workerData as WriterData;
const repository = new SqliteViewRepository(data.path);

port.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(data.start), 0, 0);

try {
  const result = await repository.commit({ draft: data.draft, expected_revision: 1 });
  port.postMessage({ type: "result", outcome: { ok: true, revision: result.view.revision } });
} catch (error) {
  port.postMessage({
    type: "result",
    outcome: {
      ok: false,
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      details: error && typeof error === "object" && "details" in error ? error.details : undefined,
      error: error instanceof Error ? error.message : String(error),
    },
  });
} finally {
  repository.close();
}

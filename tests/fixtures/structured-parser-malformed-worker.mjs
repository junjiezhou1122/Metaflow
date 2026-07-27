import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ status: "succeeded", fragments: [{ not: "a fragment" }] });

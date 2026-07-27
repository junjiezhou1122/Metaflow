import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  parseViewAccessPolicySnapshot,
} from "@info/execution";
import { exactViewRef, type ViewDraft } from "@info/view";
import { FunctionOperatorAdapter } from "../../packages/adapters/function-operator/index.js";
import { IiiRuntimeWorker, type IiiRuntimeEvent } from "../../packages/adapters/iii-runtime/index.js";
import {
  MARKDOWN_PARSER_FUNCTION,
  executeMarkdownParser,
} from "../../packages/adapters/markdown-parser/index.js";
import { SqliteViewRepository } from "../../packages/adapters/storage-sqlite/index.js";
import { obsidianMarkdownParserTransformation } from "../../apps/ambient-daemon/definitions.js";
import { parseTransformation } from "../../packages/transformation/index.js";

const ENGINE_HOST = "127.0.0.1";
const ENGINE_PORT = 49_134;
const ENGINE_URL = `ws://${ENGINE_HOST}:${ENGINE_PORT}`;
const NOW = "2026-07-27T00:00:00.000Z";

async function main(): Promise<void> {
  await assertPortAvailable();
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-parser-live-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const events: IiiRuntimeEvent[] = [];
  let engine: ChildProcess | undefined;
  let worker: IiiRuntimeWorker | undefined;
  try {
    engine = await startEngine(directory);
    const source = (await repository.commit({ draft: markdownDraft(), expected_revision: 0 })).view;
    const transformation = parseTransformation({
      ...obsidianMarkdownParserTransformation,
      inputs: [{ role: "source", required: true, sources: [{ kind: "view", ref: exactViewRef(source) }] }],
    });
    const port = new FunctionOperatorAdapter([{
      reference: MARKDOWN_PARSER_FUNCTION,
      execute: executeMarkdownParser,
    }]);
    worker = await IiiRuntimeWorker.start({
      engine_url: ENGINE_URL,
      views: repository,
      automations: { invoke: async () => ({ status: "ignored", reason: "live Parser fixture has no Automation" }) },
      operators: [{
        operator: transformation.operator,
        port,
        formations: [{
          kind: "parser",
          id: "parser.markdown",
          version: 1,
          abi_version: 1,
          transformation,
        }],
      }],
      events: { emit: event => { events.push(event); } },
      now: () => NOW,
    });
    const first = await runtime(repository, worker, "first").execute({
      run_id: "run:iii-live:parser:first",
      correlation_id: "correlation:iii-live:parser:first",
      transformation,
      access_policy: parseViewAccessPolicySnapshot(transformation.policy),
      access_use: "local_execution",
    });
    assertParserResult(first.run.status, first.outputs[0]?.schema.name, first.run.error, first.run.failure_view);

    await stopEngine(engine);
    engine = await startEngine(directory);
    await worker.verifyReadiness("restart");
    const second = await runtime(repository, worker, "second").execute({
      run_id: "run:iii-live:parser:second",
      correlation_id: "correlation:iii-live:parser:second",
      transformation,
      access_policy: parseViewAccessPolicySnapshot(transformation.policy),
      access_use: "local_execution",
    });
    assertParserResult(second.run.status, second.outputs[0]?.schema.name, second.run.error, second.run.failure_view);
    if (first.outputs[0]?.id === second.outputs[0]?.id) {
      throw new Error("Live III Parser restart reused the first Run output identity");
    }
    const readiness = events.filter(event => event.type === "iii.worker.readiness_verified");
    if (!readiness.some(event => event.payload.reason === "startup")
      || !readiness.some(event => event.payload.reason === "restart")) {
      throw new Error("Live III Parser fixture is missing startup or restart readiness evidence");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      engine_version: "0.19.2",
      parser: "parser.markdown@1@1",
      runs: [first.run.id, second.run.id],
      readiness_events: readiness.length,
    })}\n`);
  } finally {
    if (worker) await worker.close();
    if (engine) await stopEngine(engine);
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function runtime(repository: SqliteViewRepository, worker: IiiRuntimeWorker, suffix: string): ExecutionRuntime {
  let id = 0;
  return new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    worker.operatorClient,
    undefined,
    { now: () => NOW, id: kind => `${kind}:iii-live:${suffix}:${++id}` },
  );
}

async function startEngine(directory: string): Promise<ChildProcess> {
  const binary = process.env.METAFLOW_III_BINARY?.trim() || "iii";
  const child = spawn(binary, [
    "--config",
    resolve("packages/adapters/iii-runtime/iii-config.yaml"),
    "--no-update-check",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      METAFLOW_III_QUEUE_DATA: join(directory, "queue"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", chunk => remember(logs, chunk));
  child.stderr?.on("data", chunk => remember(logs, chunk));
  child.once("error", error => remember(logs, error.message));
  try {
    await waitForPort(child, logs);
    return child;
  } catch (error) {
    await stopEngine(child);
    throw error;
  }
}

async function stopEngine(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForPort(child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`III engine exited before readiness: ${logs.join("\n")}`);
    }
    if (await portOpen()) return;
    await delay(50);
  }
  throw new Error(`III engine did not listen on ${ENGINE_HOST}:${ENGINE_PORT}: ${logs.join("\n")}`);
}

async function assertPortAvailable(): Promise<void> {
  if (await portOpen()) {
    throw new Error(`Live III Parser fixture requires unused ${ENGINE_HOST}:${ENGINE_PORT}`);
  }
}

function portOpen(): Promise<boolean> {
  return new Promise(resolvePort => {
    const socket = connect({ host: ENGINE_HOST, port: ENGINE_PORT });
    socket.setTimeout(200);
    socket.once("connect", () => { socket.destroy(); resolvePort(true); });
    socket.once("timeout", () => { socket.destroy(); resolvePort(false); });
    socket.once("error", () => resolvePort(false));
  });
}

function remember(logs: string[], value: unknown): void {
  logs.push(String(value).trim());
  if (logs.length > 100) logs.shift();
}

function assertParserResult(
  status: string,
  schema: string | undefined,
  error: unknown,
  failureView: unknown,
): void {
  if (status !== "succeeded" || schema !== "metaflow.view.fragment-set") {
    throw new Error(`Live III Parser execution failed: ${JSON.stringify({
      status,
      schema: schema ?? null,
      error,
      failure_view: failureView,
    })}`);
  }
}

function markdownDraft(): ViewDraft {
  return {
    id: "view:iii-live:obsidian-markdown",
    name: "Live III Markdown input",
    purpose: "Prove the real III Parser Function and restart boundary",
    aliases: [],
    schema: { name: "capture.obsidian.document", version: 1, mode: "freeform" },
    role: "raw",
    time: { created_at: NOW },
    representation: {
      form: "inline",
      kind: "obsidian_markdown_document",
      media_type: "text/markdown",
      value: {
        vault_id: "vault:live-fixture",
        document_id: "document:live-fixture",
        relative_path: "Learning/III.md",
        revision: { sha256: "b".repeat(64), byte_length: 48, mtime_ms: 1_785_139_200_000 },
        markdown: "# III Parser\n\nExact input survives engine restart.",
        frontmatter: null,
        headings: [],
        links: [],
      },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: {
      inputs: [],
      actor: "live-fixture",
      capture: {
        connector: "fixture",
        connection_id: "fixture:iii-live",
        source_id: "view:iii-live:obsidian-markdown",
        source_kind: "fixture",
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      labels: [],
    },
    metadata: {},
  };
}

await main();

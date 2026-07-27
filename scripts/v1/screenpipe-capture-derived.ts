import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CaptureIngress, ConnectorRuntime } from "@info/capture";
import { DeterministicViewAccessAuthorizer, ExecutionRuntime } from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  ScreenpipeCaptureConnector,
  configureScreenpipeCapture,
  screenpipeSourceConnection,
} from "@info/screenpipe-capture-adapter";
import {
  SCREENPIPE_AUDIO_FUNCTION,
  SCREENPIPE_TIMELINE_FUNCTION,
  createScreenpipeDerivedTransformation,
  executeScreenpipeAudio,
  executeScreenpipeTimeline,
} from "@info/screenpipe-derived-views";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { exactViewRef, type View } from "@info/view";
import {
  resolveScreenpipeRawWindow,
  type ScreenpipeContentType,
} from "./screenpipe-derived-window.js";

const options = parseArguments(process.argv.slice(2));
const token = readLocalApiToken();
mkdirSync(options.dataDirectory, { recursive: true });
const repository = new SqliteViewRepository(join(options.dataDirectory, "metaflow.sqlite"));

try {
  const secretRef = { provider: "custom", key: "screenpipe-local-api" } as const;
  const end = new Date();
  const start = new Date(end.getTime() - options.windowMinutes * 60_000);
  const period = { start: start.toISOString(), end: end.toISOString(), timezone: options.timezone };
  const connectionScope = createHash("sha256").update(options.endpoint).digest("hex").slice(0, 24);
  const connector = new ScreenpipeCaptureConnector({
    timeout_ms: options.timeoutMs,
    secret_resolver: {
      async resolve(ref) {
        if (ref.provider !== secretRef.provider || ref.key !== secretRef.key || ref.version !== undefined) {
          throw new Error("Screenpipe requested an undeclared secret reference");
        }
        return token;
      },
    },
  });
  const connection = screenpipeSourceConnection({
    id: `screenpipe:local-derived:${connectionScope}`,
    endpoint: options.endpoint,
    required_capabilities: options.contentTypes.map(contentType => (
      contentType === "ocr" ? "frame_ocr" : contentType === "accessibility" ? "ui_accessibility" : contentType
    )),
    secret_refs: { screenpipe_api_key: secretRef },
    authentication: "bearer",
  });
  const capture = new CaptureIngress({ repository });
  const runtime = new ConnectorRuntime(repository, capture);
  await configureScreenpipeCapture({ runtime, connector, connection });

  await runtime.run(connection.id, "pull", {
    resource: "search",
    query: {
      content_types: options.contentTypes,
      start_time: period.start,
      end_time: period.end,
      limit: options.limitPerModality,
      max_content_length: options.maxContentLength,
    },
  });
  const rawViews = await resolveScreenpipeRawWindow({
    repository,
    connection_id: connection.id,
    content_types: options.contentTypes,
    period,
  });
  if (rawViews.length === 0) {
    throw new Error(`Screenpipe returned no capturable evidence in ${period.start} to ${period.end}`);
  }
  if (rawViews.length > 200) {
    throw new Error(`Screenpipe period resolved ${rawViews.length} exact Raw Views, exceeding the one-shot 200 input bound`);
  }

  const functions = new FunctionOperatorAdapter([
    { reference: SCREENPIPE_TIMELINE_FUNCTION, execute: executeScreenpipeTimeline },
    { reference: SCREENPIPE_AUDIO_FUNCTION, execute: executeScreenpipeAudio },
  ]);
  const execution = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
  );
  const suffix = period.end.replace(/[^0-9]/gu, "");
  const timeline = await executeDerived("timeline", rawViews, `view:screenpipe:timeline:${suffix}`, execution, period);
  const audioInputs = rawViews.filter(view => view.schema.name === "capture.screenpipe.audio");
  if (options.contentTypes.includes("audio") && audioInputs.length === 0) {
    throw new Error("Screenpipe returned no Audio Raw Views, so the requested Audio View was not created");
  }
  const audio = audioInputs.length === 0
    ? undefined
    : await executeDerived("audio", audioInputs, `view:screenpipe:audio-view:${suffix}`, execution, period);

  console.info(JSON.stringify({
    component: "screenpipe-capture-derived",
    event: "completed",
    data_directory: options.dataDirectory,
    period,
    raw_view_count: rawViews.length,
    raw_counts_by_schema: countBySchema(rawViews),
    timeline_view: exactViewRef(timeline),
    audio_view: audio ? exactViewRef(audio) : null,
    audio_status: audio ? "created" : "not_requested",
  }));
} finally {
  repository.close();
}

async function executeDerived(
  kind: "timeline" | "audio",
  views: View[],
  outputViewId: string,
  execution: ExecutionRuntime,
  period: { start: string; end: string; timezone: string },
): Promise<View> {
  const transformation = createScreenpipeDerivedTransformation({
    kind,
    views,
    output_view_id: outputViewId,
    expected_view_revision: 0,
    created_at: new Date().toISOString(),
    period,
  });
  const result = await execution.execute({
    run_id: `run:${outputViewId}`,
    correlation_id: `correlation:${outputViewId}`,
    transformation,
    access_policy: {
      id: "policy:screenpipe-derived-local",
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    access_use: "local_execution",
    idempotency_key: `execute:${outputViewId}`,
  });
  if (result.run.status !== "succeeded" || result.outputs.length !== 1) {
    throw new Error(`Screenpipe ${kind} Transformation failed: ${result.run.error?.code ?? "unknown_execution_failure"}`);
  }
  return result.outputs[0]!;
}

function readLocalApiToken(): string {
  const command = process.env.SCREENPIPE_CLI ?? "screenpipe";
  const result = spawnSync(command, ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Unable to obtain the local Screenpipe API token from `screenpipe auth token`");
  }
  const token = result.stdout.trim();
  if (!token || /[\r\n]/u.test(token)) throw new Error("Screenpipe returned an invalid local API token");
  return token;
}

function countBySchema(views: View[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const view of views) counts[view.schema.name] = (counts[view.schema.name] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function parseArguments(args: string[]) {
  if (args[0] === "--") args = args.slice(1);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Usage: pnpm screenpipe:derive -- [--minutes 15] [--limit 50] [--content-types ocr,audio,input,accessibility] [--data-dir path]");
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  const allowed = new Set(["--minutes", "--limit", "--content-types", "--data-dir", "--endpoint", "--timezone", "--timeout-ms", "--max-content-length"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${name}`);
  }
  const contentTypes = parseContentTypes(values.get("--content-types") ?? "ocr,audio,input,accessibility");
  const limitPerModality = boundedInteger(values.get("--limit") ?? "50", "--limit", 1, 200);
  if (contentTypes.length * limitPerModality > 200) {
    throw new Error("--limit multiplied by --content-types count must not exceed 200 exact inputs");
  }
  return {
    windowMinutes: boundedInteger(values.get("--minutes") ?? "15", "--minutes", 1, 1_440),
    limitPerModality,
    contentTypes,
    dataDirectory: values.get("--data-dir") ?? process.env.METAFLOW_DATA_DIR ?? "data/ambient-v1",
    endpoint: localScreenpipeEndpoint(values.get("--endpoint") ?? "http://127.0.0.1:3030"),
    timezone: values.get("--timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeoutMs: boundedInteger(values.get("--timeout-ms") ?? "30000", "--timeout-ms", 1_000, 120_000),
    maxContentLength: boundedInteger(values.get("--max-content-length") ?? "100000", "--max-content-length", 1, 1_000_000),
  };
}

function localScreenpipeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new Error("--endpoint must be a valid local Screenpipe URL", { cause });
  }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password
    || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]")) {
    throw new Error("--endpoint must be an explicit HTTP loopback address (127.0.0.1 or [::1])");
  }
  return endpoint.toString().replace(/\/$/u, "");
}

function parseContentTypes(value: string): ScreenpipeContentType[] {
  const allowed = new Set<ScreenpipeContentType>(["ocr", "audio", "input", "accessibility"]);
  const parsed = value.split(",").map(item => item.trim()).filter(Boolean);
  if (parsed.length === 0 || new Set(parsed).size !== parsed.length || parsed.some(item => !allowed.has(item as ScreenpipeContentType))) {
    throw new Error("--content-types must be a non-empty unique list of ocr,audio,input,accessibility");
  }
  return parsed as ScreenpipeContentType[];
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CaptureIngress,
  CaptureRuntimeError,
  ConnectorRuntime,
  type CaptureRetryPolicy,
} from "@info/capture";
import {
  ScreenpipeCaptureConnector,
  configureScreenpipeCapture,
  screenpipeSourceConnection,
  type ScreenpipeSecretResolver,
} from "@info/screenpipe-capture-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { ViewRepositoryError } from "@info/view";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "screenpipe");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDirectory, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function privatePolicy() {
  return {
    owner: "user:local",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T12:10:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

async function setup(input: {
  fetch: typeof fetch;
  required_capabilities?: string[];
  repository?: SqliteViewRepository;
  retry_policy?: CaptureRetryPolicy;
  secret_resolver?: ScreenpipeSecretResolver | null;
}) {
  const repository = input.repository ?? new SqliteViewRepository(":memory:");
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository }), {
    now: deterministicClock(),
    ...(input.retry_policy ? { retry_policy: input.retry_policy } : {}),
  });
  const connector = new ScreenpipeCaptureConnector({
    fetch: input.fetch,
    now: deterministicClock(),
    ...(input.secret_resolver === null
      ? {}
      : { secret_resolver: input.secret_resolver ?? { resolve: async () => "local-test-key" } }),
  });
  const connection = screenpipeSourceConnection({
    endpoint: "http://screenpipe.test",
    privacy: privatePolicy(),
    required_capabilities: input.required_capabilities,
    secret_refs: { screenpipe_api_key: { provider: "keychain", key: "screenpipe.local-api-key" } },
  });
  await configureScreenpipeCapture({ runtime, connector, connection });
  return { repository, runtime, connector, connection };
}

function recordedFixtureFetch(calls: string[]): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      url.pathname === "/health" ? null : "Bearer local-test-key",
    );
    if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
    if (url.pathname === "/search") {
      const contentType = url.searchParams.get("content_type");
      const name = contentType === "ocr"
        ? "search-ocr.json"
        : contentType === "audio"
          ? "search-audio.json"
          : contentType === "input"
            ? "search-input.json"
            : "search-accessibility.json";
      return jsonResponse(withPaginationOffset(fixture(name), Number(url.searchParams.get("offset") ?? 0)));
    }
    if (url.pathname === "/elements") {
      return jsonResponse(withPaginationOffset(fixture("elements.json"), Number(url.searchParams.get("offset") ?? 0)));
    }
    if (url.pathname === "/activity-summary") return jsonResponse(fixture("activity-summary.json"));
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
}

function withPaginationOffset(value: unknown, offset: number): unknown {
  const object = structuredClone(value) as { pagination?: { offset?: number } };
  if (object.pagination) object.pagination.offset = offset;
  return object;
}

function ocrItem(frameId: number, timestamp: string, text = `frame ${frameId}`) {
  const value = structuredClone(fixture("search-ocr.json")) as {
    data: Array<{
      type: "OCR";
      content: { frame_id: number; timestamp: string; text: string } & Record<string, unknown>;
    }>;
  };
  const item = value.data[0]!;
  item.content.frame_id = frameId;
  item.content.timestamp = timestamp;
  item.content.text = text;
  return item;
}

function pagedSearch(items: ReturnType<typeof ocrItem>[], url: URL): unknown {
  assert.equal(url.searchParams.get("order"), "ascending");
  const start = url.searchParams.get("start_time");
  const end = url.searchParams.get("end_time");
  const filtered = items
    .filter(item => !start || Date.parse(item.content.timestamp) >= Date.parse(start))
    .filter(item => !end || Date.parse(item.content.timestamp) <= Date.parse(end))
    .sort((left, right) => (
      Date.parse(left.content.timestamp) - Date.parse(right.content.timestamp)
      || left.content.frame_id - right.content.frame_id
    ));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return {
    data: filtered.slice(offset, offset + limit),
    pagination: { limit, offset, total: filtered.length },
  };
}

test("recorded Screenpipe REST fixtures retain source-native modalities through Runtime and SQLite", async () => {
  const calls: string[] = [];
  const harness = await setup({
    fetch: recordedFixtureFetch(calls),
    required_capabilities: [
      "frame_ocr",
      "audio",
      "input",
      "ui_accessibility",
      "ui_element",
      "activity_summary",
    ],
  });
  try {
    const search = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr", "audio", "input", "accessibility"], limit: 50 },
    });
    assert.equal(search.length, 1);
    assert.equal(search[0]?.receipts.length, 4);
    const modalityCheckpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    const modalityWatermarks = (modalityCheckpoint?.cursor as {
      screenpipe?: { search_watermarks?: Record<string, unknown> };
    }).screenpipe?.search_watermarks;
    assert.deepEqual(Object.keys(modalityWatermarks ?? {}).sort(), ["accessibility", "audio", "input", "ocr"]);

    const elements = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "elements",
      query: { limit: 50 },
    });
    assert.equal(elements[0]?.receipts.length, 1);

    const activity = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "activity",
      query: {
        start_time: "2026-07-26T12:00:00.000Z",
        end_time: "2026-07-26T12:05:00.000Z",
      },
    });
    assert.equal(activity[0]?.receipts.length, 1);

    const views = await harness.repository.query({ role: "raw", revisions: "all", limit: 20 });
    assert.deepEqual(new Set(views.map(view => view.schema.name)), new Set([
      "capture.screenpipe.frame_ocr",
      "capture.screenpipe.audio",
      "capture.screenpipe.input",
      "capture.screenpipe.ui_accessibility",
      "capture.screenpipe.ui_element",
      "capture.screenpipe.activity_summary",
    ]));
    const frame = views.find(view => view.schema.name === "capture.screenpipe.frame_ocr");
    assert.ok(frame);
    assert.equal(frame.provenance.capture?.source_id, "frame:42");
    assert.equal(frame.provenance.capture?.identity, "stable_source");
    assert.match(JSON.stringify(frame.representation.metadata), /screenpipe%3Adefault\/frame\/42/);
    assert.doesNotMatch(JSON.stringify(frame.representation), /data:image|base64/);
    assert.match(JSON.stringify(frame.representation), /"text_source":"accessibility"/);

    const audio = views.find(view => view.schema.name === "capture.screenpipe.audio");
    assert.ok(audio);
    assert.match(audio.provenance.capture?.source_id ?? "", /^audio:[a-f0-9]{32}$/);
    assert.notEqual(audio.provenance.capture?.source_id, "audio:7");
    assert.match(JSON.stringify(audio.representation.metadata), /screenpipe_audio_chunk/);

    const inputView = views.find(view => view.schema.name === "capture.screenpipe.input");
    assert.equal(inputView?.provenance.capture?.identity, "stable_source");
    const summary = views.find(view => view.schema.name === "capture.screenpipe.activity_summary");
    assert.equal(summary?.provenance.capture?.assertion, "source_derived");
    assert.equal(summary?.role, "raw");
    assert.deepEqual((await harness.repository.query({ text: "exact Raw View evidence" })).map(view => view.schema.name), [
      "capture.screenpipe.frame_ocr",
    ]);
    assert.deepEqual((await harness.repository.query({ text: "View Algebra" })).map(view => view.schema.name), [
      "capture.screenpipe.input",
    ]);
    assert.deepEqual((await harness.repository.query({ text: "我们继续设计 View" })).map(view => view.schema.name), [
      "capture.screenpipe.audio",
    ]);
    assert.deepEqual((await harness.repository.query({ text: "github junjiezhou1122 Metaflow issues 35" })).map(view => view.schema.name), [
      "capture.screenpipe.ui_accessibility",
    ]);

    const searchRequests = calls.filter(value => new URL(value).pathname === "/search");
    assert.ok(searchRequests.length >= 4);
    assert.equal(searchRequests.some(value => new URL(value).searchParams.get("content_type") === "all"), false);
    assert.deepEqual(new Set(searchRequests.map(value => new URL(value).searchParams.get("content_type"))), new Set([
      "ocr", "audio", "input", "accessibility",
    ]));
    assert.equal(searchRequests.every(value => new URL(value).searchParams.get("include_frames") === "false"), true);
    assert.equal(searchRequests.every(value => new URL(value).searchParams.get("order") === "ascending"), true);
    assert.equal((await harness.runtime.health(harness.connection.id)).status, "healthy");
  } finally {
    harness.repository.close();
  }
});

test("incompatible and degraded health responses fail before capability probes", async () => {
  for (const [name, expectedCode] of [
    ["health-incompatible-0.5.0.json", "screenpipe_incompatible_version"],
    ["health-degraded.json", "screenpipe_unhealthy"],
  ] as const) {
    const calls: string[] = [];
    const harness = await setup({
      required_capabilities: ["frame_ocr"],
      fetch: (async (input: URL | RequestInfo) => {
        calls.push(String(input));
        return jsonResponse(fixture(name));
      }) as typeof fetch,
    });
    try {
      await assert.rejects(
        harness.runtime.run(harness.connection.id, "pull", {
          resource: "search",
          query: { content_types: ["ocr"] },
        }),
        (error: unknown) => error instanceof CaptureRuntimeError && error.code === expectedCode,
      );
      assert.equal(calls.length, 1);
      assert.equal(new URL(calls[0]!).pathname, "/health");
      assert.equal((await harness.runtime.health(harness.connection.id)).status, "degraded");
      assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
    } finally {
      harness.repository.close();
    }
  }
});

test("unknown Screenpipe variants fail observably without advancing the checkpoint", async () => {
  let ocrCalls = 0;
  const harness = await setup({
    required_capabilities: ["frame_ocr"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      if (url.pathname === "/search" && url.searchParams.get("content_type") === "ocr") {
        ocrCalls += 1;
        return jsonResponse(fixture(ocrCalls === 1 ? "search-ocr.json" : "search-unknown-variant.json"));
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["ocr"] },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "screenpipe_schema_incompatible",
    );
    assert.equal((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.revision, 0);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
    const trace = await harness.repository.getCaptureTrace(harness.connection.id);
    assert.ok(trace.some(event => event.error?.code === "screenpipe_schema_incompatible"));
  } finally {
    harness.repository.close();
  }
});

test("unavailable and unauthorized Screenpipe sources remain explicit health failures", async () => {
  for (const [fetchImplementation, expectedCode] of [
    [async () => { throw new TypeError("connection refused with api_key=must-not-leak"); }, "screenpipe_unavailable"],
    [async () => jsonResponse({ error: "forbidden" }, 403), "screenpipe_http_error"],
  ] as const) {
    const harness = await setup({
      required_capabilities: ["frame_ocr"],
      fetch: fetchImplementation as typeof fetch,
    });
    try {
      await assert.rejects(
        harness.runtime.run(harness.connection.id, "pull", {
          resource: "search",
          query: { content_types: ["ocr"] },
        }),
        (error: unknown) => error instanceof CaptureRuntimeError
          && error.code === expectedCode
          && error.retryable === (expectedCode === "screenpipe_unavailable"),
      );
      const health = await harness.runtime.health(harness.connection.id);
      const trace = await harness.repository.getCaptureTrace(harness.connection.id);
      assert.equal(health.status, "degraded");
      assert.doesNotMatch(JSON.stringify({ health, trace }), /must-not-leak|local-test-key|api_key/);
    } finally {
      harness.repository.close();
    }
  }
});

test("bearer authentication resolves the exact reference only for protected endpoints without durable secret leakage", async () => {
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const resolved: unknown[] = [];
  const harness = await setup({
    required_capabilities: ["frame_ocr"],
    secret_resolver: {
      resolve: async ref => {
        resolved.push(ref);
        return "resolved-secret-must-not-leak";
      },
    },
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      return jsonResponse({ error: "forbidden" }, 403);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["ocr"] },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError
        && error.code === "screenpipe_http_error"
        && error.retryable === false,
    );
    assert.deepEqual(resolved, [{ provider: "keychain", key: "screenpipe.local-api-key" }]);
    assert.deepEqual(calls, [
      { path: "/health", authorization: null },
      { path: "/search", authorization: "Bearer resolved-secret-must-not-leak" },
    ]);
    const durable = {
      health: await harness.runtime.health(harness.connection.id),
      checkpoint: await harness.repository.getCaptureCheckpoint(harness.connection.id),
      trace: await harness.repository.getCaptureTrace(harness.connection.id),
      dead_letters: await harness.repository.listCaptureDeadLetters(harness.connection.id),
      views: await harness.repository.query({ role: "raw", revisions: "all", limit: 10 }),
    };
    assert.doesNotMatch(JSON.stringify(durable), /resolved-secret-must-not-leak/);
  } finally {
    harness.repository.close();
  }
});

test("missing or empty Screenpipe secret resolution fails before protected provider access", async () => {
  for (const secretResolver of [null, { resolve: async () => "" }] as const) {
    const calls: string[] = [];
    const harness = await setup({
      required_capabilities: ["frame_ocr"],
      secret_resolver: secretResolver,
      fetch: (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
        return jsonResponse(fixture("search-ocr.json"));
      }) as typeof fetch,
    });
    try {
      await assert.rejects(
        harness.runtime.run(harness.connection.id, "pull", {
          resource: "search",
          query: { content_types: ["ocr"] },
        }),
        (error: unknown) => error instanceof CaptureRuntimeError
          && error.code === "screenpipe_auth_configuration"
          && error.retryable === false,
      );
      assert.deepEqual(calls, ["/health"]);
      assert.deepEqual((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.cursor, {});
    } finally {
      harness.repository.close();
    }
  }
});

test("a failure in one Screenpipe modality freezes every modality checkpoint and candidate", async () => {
  const harness = await setup({
    required_capabilities: ["frame_ocr", "audio"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      const modality = url.searchParams.get("content_type");
      const isCapture = url.searchParams.has("max_content_length");
      if (modality === "audio" && isCapture) return jsonResponse({ error: "overloaded" }, 503);
      return jsonResponse(fixture(modality === "audio" ? "search-audio.json" : "search-ocr.json"));
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["ocr", "audio"], limit: 1 },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError
        && error.code === "screenpipe_http_error"
        && error.retryable,
    );
    assert.deepEqual((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.cursor, {});
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
  } finally {
    harness.repository.close();
  }
});

test("audio device and speaker provider shapes are strict", async () => {
  let captures = 0;
  const harness = await setup({
    required_capabilities: ["audio"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      const response = structuredClone(fixture("search-audio.json")) as {
        data: Array<{ content: { device_type: string; speaker: unknown } }>;
      };
      if (url.searchParams.has("max_content_length") && captures++ === 0) {
        response.data[0]!.content.device_type = "input";
        response.data[0]!.content.speaker = { id: 1, name: "Junjie", metadata: {} };
      }
      return jsonResponse(response);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["audio"] },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "screenpipe_schema_incompatible",
    );
    assert.deepEqual((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.cursor, {});
  } finally {
    harness.repository.close();
  }
});

test("background speaker and live Output audio variants retain their exact upstream optional shapes", async () => {
  const harness = await setup({
    required_capabilities: ["audio"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      if (!url.searchParams.has("max_content_length")) return jsonResponse(fixture("search-audio.json"));
      const background = structuredClone(fixture("search-audio.json")) as { data: unknown[] };
      const live = structuredClone(fixture("search-audio-live-output.json")) as { data: unknown[] };
      return jsonResponse({
        data: [...background.data, ...live.data],
        pagination: { limit: 50, offset: 0, total: 2 },
      });
    }) as typeof fetch,
  });
  try {
    const result = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["audio"], limit: 50 },
    });
    assert.equal(result[0]?.receipts.length, 2);
    const values = (await harness.repository.query({ schema_name: "capture.screenpipe.audio", revisions: "all", limit: 10 }))
      .map(view => JSON.stringify(view.representation.value));
    assert.ok(values.some(value => /"device_type":"Input"/.test(value) && /"speaker_source":"speaker_id"/.test(value)));
    assert.ok(values.some(value => /"device_type":"Output"/.test(value) && /"speaker":null/.test(value) && /"source":"live"/.test(value)));
  } finally {
    harness.repository.close();
  }
});

test("Screenpipe HTTP failures distinguish retryable overload from terminal server errors", async () => {
  for (const [status, headers, expectedRetryable] of [
    [400, {}, false],
    [403, {}, false],
    [404, {}, false],
    [408, {}, true],
    [503, { "retry-after": "7" }, true],
    [504, {}, true],
    [500, {}, false],
  ] as const) {
    const harness = await setup({
      required_capabilities: ["frame_ocr"],
      fetch: (async () => jsonResponse({ error: "provider failure" }, status, headers)) as typeof fetch,
    });
    try {
      await assert.rejects(
        harness.runtime.run(harness.connection.id, "pull", {
          resource: "search",
          query: { content_types: ["ocr"] },
        }),
        (error: unknown) => error instanceof CaptureRuntimeError
          && error.code === "screenpipe_http_error"
          && error.retryable === expectedRetryable
          && error.details.status === status
          && (status !== 503 || error.details.retry_after === "7"),
      );
      const health = await harness.runtime.health(harness.connection.id);
      assert.equal(health.last_error?.retryable, expectedRetryable);
      assert.equal(health.last_error?.details.status, status);
    } finally {
      harness.repository.close();
    }
  }
});

test("failed admission freezes the watermark and exact replay remains stable across overlap", async () => {
  const base = new SqliteViewRepository(":memory:");
  let failCommit = true;
  const repository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "commitCaptureBatch") {
        return async (...args: Parameters<SqliteViewRepository["commitCaptureBatch"]>) => {
          if (failCommit) {
            failCommit = false;
            throw new ViewRepositoryError(
              "forced Screenpipe admission failure",
              "storage_failure",
              { operation: "commit_capture_batch", phase: "test" },
            );
          }
          return target.commitCaptureBatch(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqliteViewRepository;
  const items = [ocrItem(42, "2026-07-26T12:00:01.000Z")];
  const actualRequests: URL[] = [];
  const harness = await setup({
    repository,
    required_capabilities: ["frame_ocr"],
    retry_policy: {
      id: "capture-retry:screenpipe-test",
      revision: 1,
      max_attempts: 1,
      retryable_codes: ["storage_failure"],
      non_retryable_codes: [],
    },
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      if (url.pathname === "/search") {
        if (url.searchParams.has("max_content_length")) actualRequests.push(url);
        return jsonResponse(pagedSearch(items, url));
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["ocr"], limit: 1 },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "storage_failure",
    );
    assert.deepEqual((await repository.getCaptureCheckpoint(harness.connection.id))?.cursor, {});
    const deadLetters = await repository.listCaptureDeadLetters(harness.connection.id, "pending");
    assert.equal(deadLetters.length, 1);

    const recovered = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    assert.equal(recovered[0]?.receipts[0]?.status, "stored");
    const replay = await harness.runtime.replayDeadLetter(deadLetters[0]!.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipts[0]?.status, "stored");
    const replayedCheckpoint = await repository.getCaptureCheckpoint(harness.connection.id);
    assert.equal(replayedCheckpoint?.revision, 1);
    const replayedCursor = replayedCheckpoint?.cursor as {
      screenpipe?: { search_watermarks?: { ocr?: { observed_at: string; seen: unknown[] } } };
    };
    assert.equal(replayedCursor.screenpipe?.search_watermarks?.ocr?.observed_at, "2026-07-26T12:00:01.000Z");
    assert.equal(replayedCursor.screenpipe?.search_watermarks?.ocr?.seen.length, 1);

    const duplicate = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    assert.deepEqual(duplicate, []);
    assert.equal((await repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 1);

    items.unshift(ocrItem(41, "2026-07-26T12:00:00.500Z", "late row inserted before the old offset"));
    const late = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    assert.equal(late[0]?.receipts[0]?.status, "stored");
    const checkpoint = await repository.getCaptureCheckpoint(harness.connection.id);
    assert.equal(checkpoint?.revision, 2);
    assert.equal((checkpoint?.cursor as {
      screenpipe?: { search_watermarks?: { ocr?: { seen: unknown[] } } };
    }).screenpipe?.search_watermarks?.ocr?.seen.length, 2);
    assert.equal(actualRequests.every(url => url.searchParams.get("offset") === "0"), true);
    assert.equal(actualRequests[0]?.searchParams.get("start_time"), null);
    assert.equal(actualRequests[1]?.searchParams.get("start_time"), null);
    assert.equal(actualRequests[2]?.searchParams.get("start_time"), "2026-07-26T11:59:01.000Z");
    assert.equal(actualRequests[3]?.searchParams.get("start_time"), "2026-07-26T11:59:01.000Z");
    assert.deepEqual((await repository.query({ text: "late row inserted" })).map(view => view.provenance.capture?.source_id), ["frame:41"]);
  } finally {
    base.close();
  }
});

test("inclusive overlap scans past replayed rows and advances multiple identities at the same timestamp", async () => {
  const items = [
    ocrItem(42, "2026-07-26T12:00:01.000Z", "same timestamp first"),
    ocrItem(43, "2026-07-26T12:00:01.000Z", "same timestamp second"),
  ];
  const offsets: number[] = [];
  const harness = await setup({
    required_capabilities: ["frame_ocr"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      if (url.searchParams.has("max_content_length")) offsets.push(Number(url.searchParams.get("offset") ?? 0));
      return jsonResponse(pagedSearch(items, url));
    }) as typeof fetch,
  });
  try {
    const first = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    assert.equal(first[0]?.receipts[0]?.status, "stored");
    const second = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    assert.equal(second[0]?.receipts[0]?.status, "stored");
    const replay = await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    assert.deepEqual(replay, []);
    assert.deepEqual(offsets, [0, 0, 1, 0, 1]);
    const views = await harness.repository.query({ role: "raw", revisions: "all", limit: 10 });
    assert.deepEqual(views.map(view => view.provenance.capture?.source_id).sort(), ["frame:42", "frame:43"]);
    const checkpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    const ocr = (checkpoint?.cursor as {
      screenpipe?: { search_watermarks?: { ocr?: { observed_at: string; seen: unknown[] } } };
    }).screenpipe?.search_watermarks?.ocr;
    assert.equal(ocr?.observed_at, "2026-07-26T12:00:01.000Z");
    assert.equal(ocr?.seen.length, 2);
  } finally {
    harness.repository.close();
  }
});

test("a modality watermark rejects selector drift instead of silently applying the old scope", async () => {
  const captureRequests: URL[] = [];
  const harness = await setup({
    required_capabilities: ["frame_ocr"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      if (url.searchParams.has("max_content_length")) captureRequests.push(url);
      return jsonResponse(pagedSearch([ocrItem(42, "2026-07-26T12:00:01.000Z")], url));
    }) as typeof fetch,
  });
  try {
    await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], app_name: "App A", start_time: "2026-07-26T09:00:00.000Z", limit: 1 },
    });
    const before = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["ocr"], app_name: "App B", start_time: "2026-07-26T09:00:00.000Z", limit: 1 },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError
        && error.code === "screenpipe_checkpoint_scope_mismatch"
        && error.retryable === false,
    );
    assert.equal(captureRequests.length, 1);
    assert.deepEqual(await harness.repository.getCaptureCheckpoint(harness.connection.id), before);
  } finally {
    harness.repository.close();
  }
});

test("connection-scoped idempotency isolates identical rows and Input enrichment becomes one stable revision chain", async () => {
  const repository = new SqliteViewRepository(":memory:");
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository }), { now: deterministicClock() });
  let frameId: number | undefined;
  const connector = new ScreenpipeCaptureConnector({
    secret_resolver: { resolve: async () => "local-test-key" },
    now: deterministicClock(),
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      const response = structuredClone(fixture("search-input.json")) as {
        data: Array<{ content: { frame_id?: number } }>;
      };
      if (frameId === undefined) delete response.data[0]!.content.frame_id;
      else response.data[0]!.content.frame_id = frameId;
      return jsonResponse(response);
    }) as typeof fetch,
  });
  const secret_refs = { screenpipe_api_key: { provider: "keychain" as const, key: "screenpipe.local-api-key" } };
  const first = screenpipeSourceConnection({ id: "screenpipe:first", required_capabilities: ["input"], secret_refs });
  const second = screenpipeSourceConnection({ id: "screenpipe:second", required_capabilities: ["input"], secret_refs });
  try {
    runtime.registerConnector(connector);
    await runtime.registerConnection(first);
    await runtime.registerConnection(second);
    await runtime.run(first.id, "pull", { resource: "search", query: { content_types: ["input"] } });
    frameId = 42;
    await runtime.run(first.id, "pull", { resource: "search", query: { content_types: ["input"] } });
    await runtime.run(second.id, "pull", { resource: "search", query: { content_types: ["input"] } });
    const views = await repository.query({ schema_name: "capture.screenpipe.input", revisions: "all", limit: 10 });
    const firstViews = views.filter(view => view.provenance.capture?.connection_id === first.id);
    const secondViews = views.filter(view => view.provenance.capture?.connection_id === second.id);
    assert.deepEqual(firstViews.map(view => view.revision).sort(), [1, 2]);
    assert.equal(new Set(firstViews.map(view => view.id)).size, 1);
    assert.equal(secondViews.length, 1);
    assert.notEqual(firstViews[0]?.id, secondViews[0]?.id);
  } finally {
    repository.close();
  }
});

test("an overlap scan that cannot reach new evidence fails observably without moving its watermark", async () => {
  const item = ocrItem(42, "2026-07-26T12:00:01.000Z", "bounded overlap sentinel");
  let stalled = false;
  let stalledPages = 0;
  const harness = await setup({
    required_capabilities: ["frame_ocr"],
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
      if (!url.searchParams.has("max_content_length")) {
        return jsonResponse({ data: [item], pagination: { limit: 1, offset: 0, total: 1 } });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (stalled) stalledPages += 1;
      return jsonResponse({
        data: [item],
        pagination: { limit: 1, offset, total: stalled ? 201 : 1 },
      });
    }) as typeof fetch,
  });
  try {
    await harness.runtime.run(harness.connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1 },
    });
    const before = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    stalled = true;
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {
        resource: "search",
        query: { content_types: ["ocr"], limit: 1 },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError
        && error.code === "screenpipe_overlap_scan_exhausted"
        && error.retryable === false,
    );
    assert.equal(stalledPages, 200);
    assert.deepEqual(await harness.repository.getCaptureCheckpoint(harness.connection.id), before);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 1);
  } finally {
    harness.repository.close();
  }
});

test("live local Screenpipe smoke", { skip: process.env.SCREENPIPE_LIVE_TEST !== "1" }, async () => {
  const repository = new SqliteViewRepository(":memory:");
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository }));
  const connector = new ScreenpipeCaptureConnector({
    secret_resolver: {
      resolve: async () => {
        if (!process.env.SCREENPIPE_API_KEY) throw new Error("SCREENPIPE_API_KEY is required for the live smoke");
        return process.env.SCREENPIPE_API_KEY;
      },
    },
  });
  const connection = screenpipeSourceConnection({
    required_capabilities: ["frame_ocr"],
    secret_refs: { screenpipe_api_key: { provider: "env", key: "SCREENPIPE_API_KEY" } },
  });
  try {
    await configureScreenpipeCapture({ runtime, connector, connection });
    await runtime.run(connection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 1, max_content_length: 10_000 },
    });
    assert.equal((await runtime.health(connection.id)).status, "healthy");
  } finally {
    repository.close();
  }
});

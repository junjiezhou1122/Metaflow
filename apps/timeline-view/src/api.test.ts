import test from "node:test";
import assert from "node:assert/strict";
import { TimelineClient, TimelineClientError, localDatePeriod, thumbnailRequestWidth, todayInputValue } from "./api.js";

test("localDatePeriod uses the declared IANA timezone", () => {
  assert.deepEqual(localDatePeriod("2026-07-28", "Asia/Shanghai"), {
    start: "2026-07-27T16:00:00.000Z",
    end: "2026-07-28T16:00:00.000Z",
  });
});

test("localDatePeriod preserves a DST-shortened calendar day", () => {
  assert.deepEqual(localDatePeriod("2026-03-08", "America/New_York"), {
    start: "2026-03-08T05:00:00.000Z",
    end: "2026-03-09T04:00:00.000Z",
  });
});

test("todayInputValue is projected in the requested timezone", () => {
  const instant = new Date("2026-07-28T01:00:00.000Z");
  assert.equal(todayInputValue(instant, "Asia/Shanghai"), "2026-07-28");
  assert.equal(todayInputValue(instant, "America/Los_Angeles"), "2026-07-27");
});

test("thumbnailRequestWidth uses rendered pixels with bounded resolution buckets", () => {
  assert.equal(thumbnailRequestWidth(720, 2), 1440);
  assert.equal(thumbnailRequestWidth(320, 2), 720);
  assert.equal(thumbnailRequestWidth(4000, 3), 1920);
  assert.equal(thumbnailRequestWidth(0, Number.NaN), 720);
});

test("TimelineClient runs the generation-bound Screenpipe connection", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({
      ok: true,
      request_id: "request:test",
      operation: "capture.connection.run",
      data: { action: "run", generation: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await new TimelineClient().pull("screenpipe:test", 7);
    assert.equal(request?.url, "/metaflow/v1/operations/capture.connection.run");
    assert.equal(request?.body.connection_id, "screenpipe:test");
    assert.equal(request?.body.expected_generation, 7);
    assert.equal(request?.body.delivery, "pull");
    assert.match(String(request?.body.idempotency_key), /^timeline:refresh:/u);
    assert.equal((request?.body.parameters as { resource?: unknown }).resource, "search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TimelineClient preserves structured Operation failures from HTTP", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    request_id: "request:test",
    operation: "view.query",
    error: {
      code: "screenpipe_unhealthy",
      message: "Screenpipe health is degraded (503)",
      category: "failed_dependency",
      details: { status: "degraded" },
    },
  }), { status: 502, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      new TimelineClient().page({
        subject: { view_id: "view:screenpipe:timeline-index:test", revision: 1 },
        date: "2026-07-28",
        timezone: "Asia/Shanghai",
        filters: { modalities: ["screen"], hasImage: false, focused: false },
      }),
      (error: unknown) => error instanceof TimelineClientError
        && error.code === "screenpipe_unhealthy"
        && error.message === "Screenpipe health is degraded (503)",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

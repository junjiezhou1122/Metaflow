import test from "node:test";
import assert from "node:assert/strict";
import {
  browserAutomationEndpoint,
  browserDeliveriesEndpoint,
  browserExactViewEndpoint,
  browserInteractionEndpoint,
  buildBrowserAutomationEvent,
  buildBrowserDeliveryInteraction,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/ambient/browser-trigger.ts";
import { AutomationDeliveryInteractionSchema } from "../packages/automation/index.ts";
import { parseBrowserPageEvent } from "../packages/adapters/browser-automation/index.ts";

test("Chrome extension emits a Browser Automation event accepted by the backend contract", () => {
  const event = buildBrowserAutomationEvent({
    message: {
      event_id: "browser-event:github:codex:1",
      navigation_id: "navigation:github:codex:1",
      reason_kind: "dom",
      dwell_ms: 31_000,
      scroll_depth: 0.75,
      scroll_events: 4,
      selection_count: 1,
      dom: {
        github_repository: true,
        markers: { readme: true, language: "TypeScript" },
      },
    },
    tab: {
      id: 42,
      windowId: 7,
      url: "https://github.com/openai/codex",
      title: "openai/codex",
    },
    page: {
      text: "Codex is a coding agent.",
      selected_text: "coding agent",
      observed_at: "2026-07-26T10:00:30.000Z",
      metadata: { content_source: "document.body.innerText" },
      text_quality: { complete: true },
    },
    visit_id: "visit:github:codex:1",
    started_at_ms: 0,
    privacy: {
      level: "private",
      retention: "session",
      allow_external_llm: true,
      allow_embedding: false,
    },
    now: "2026-07-26T10:00:31.000Z",
    id_factory: () => "must-not-be-used",
  });

  const parsed = parseBrowserPageEvent(event);
  assert.equal(parsed.event_id, "browser-event:github:codex:1");
  assert.equal(parsed.reason, "dom");
  assert.equal(parsed.dom.github_repository, true);
  assert.equal(parsed.dom.repository_owner, "openai");
  assert.equal(parsed.dom.repository_name, "codex");
  assert.deepEqual(parsed.dom.markers, { readme: true, language: "TypeScript" });
  assert.equal(parsed.page.selected_text, "coding agent");
  assert.equal(parsed.policy.retention, "session");
  assert.equal(parsed.policy.allow_external_model, true);
});

test("Chrome extension derives dwell from the supplied event clock", () => {
  const event = buildBrowserAutomationEvent({
    message: { reason_kind: "manual" },
    tab: { id: 1, url: "https://example.com/article" },
    page: { text: "Deterministic replay." },
    visit_id: "visit:deterministic:1",
    started_at_ms: Date.parse("2026-07-26T09:59:30.000Z"),
    privacy: {},
    now: "2026-07-26T10:00:00.000Z",
    id_factory: () => "browser-event:deterministic:1",
  });
  assert.equal(event.dwell_ms, 30_000);
});

test("Chrome extension projects the Capture endpoint to the Browser Automation surface", () => {
  assert.equal(
    browserAutomationEndpoint("http://localhost:3111/context/v1/observations?process=true"),
    "http://localhost:3111/automation/v1/browser-signals",
  );
});

test("Chrome extension builds Browser delivery polling and interaction requests", () => {
  assert.equal(
    browserDeliveriesEndpoint("http://localhost:3111/context/v1/observations", {
      after: "2026-07-26T10:00:31.000Z",
      limit: 20,
    }),
    "http://localhost:3111/automation/v1/browser-deliveries?after=2026-07-26T10%3A00%3A31.000Z&limit=20",
  );
  assert.equal(
    browserInteractionEndpoint("http://localhost:3111/context/v1/observations"),
    "http://localhost:3111/automation/v1/browser-interactions",
  );
  assert.equal(
    browserExactViewEndpoint("http://localhost:3111/context/v1/observations", {
      view_id: "summary:github/openai/codex",
      revision: 2,
    }),
    "http://localhost:3111/context/v1/views/summary%3Agithub%2Fopenai%2Fcodex?revision=2",
  );

  const interaction = AutomationDeliveryInteractionSchema.parse(buildBrowserDeliveryInteraction({
    request_id: "delivery-request:github:1",
    delivery_id: "browser-delivery:delivery-request:github:1",
    action: "accept",
    metadata: { source: "ambient-card" },
    now: "2026-07-26T10:01:00.000Z",
    id_factory: () => "interaction:github:1",
  }));
  assert.equal(interaction.surface, "browser");
  assert.equal(interaction.actor, "user:local");
  assert.equal(interaction.action, "accept");
});

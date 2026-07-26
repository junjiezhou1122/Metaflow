import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutomationContextResolver,
  InMemoryAutomationDeliveryLedger,
  AutomationRuntime,
  parseAutomationDefinition,
  type AutomationTargetRequest,
} from "../packages/automation/index.ts";
import {
  BrowserAutomationAdapterError,
  BrowserAutomationController,
  BrowserAutomationHttpBridge,
  BrowserDeliveryMailbox,
  ViewBrowserAutomationCatalog,
} from "../packages/adapters/browser-automation/index.ts";
import { SqliteAutomationOccurrenceRepository } from "../packages/adapters/automation-sqlite/index.ts";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";
import { CaptureIngress, ConnectorRuntime } from "../packages/capture/index.ts";
import {
  browserSourceConnection,
  configureBrowserCapture,
} from "../packages/adapters/browser-capture/index.ts";
import { parseViewDraft } from "../packages/view/index.ts";

test("Browser adapter matches cheap URL/DOM state before admitting exact page and selection Views", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-browser-automation-"));
  const views = new SqliteViewRepository(join(directory, "views.sqlite"));
  const occurrences = new SqliteAutomationOccurrenceRepository(join(directory, "automation.sqlite"));
  const targetRequests: AutomationTargetRequest[] = [];
  const deliveries: string[] = [];
  try {
    await views.commit({ draft: automationDraft(), expected_revision: 0 });
    const runtime = new AutomationRuntime({
      occurrences,
      context: new AutomationContextResolver({
        views,
        authorizer: {
          async authorize({ view }) {
            return { allowed: true, decision_id: `allow:${view.id}@${view.revision}`, reason: "local Browser evidence" };
          },
        },
      }),
      target: {
        async execute(request) {
          targetRequests.push(request);
          return {
            status: "succeeded",
            run_id: "run:browser:github:1",
            output_views: [{ view_id: "view:summary:test-only", revision: 1 }],
          };
        },
      },
      delivery: {
        async deliver(request) {
          deliveries.push(request.phase);
          return { status: "delivered", delivery_id: `browser:${request.id}` };
        },
      },
      events: { emit() {} },
      now: () => new Date("2026-07-26T10:00:31.100Z"),
    });
    const captureIngress = new CaptureIngress({ repository: views });
    const connectorRuntime = new ConnectorRuntime(views, captureIngress);
    const browserCapture = await configureBrowserCapture({
      runtime: connectorRuntime,
      connection: browserSourceConnection({ id: "chrome:profile-1" }),
    });
    const controller = new BrowserAutomationController({
      capture: browserCapture,
      catalog: new ViewBrowserAutomationCatalog(views),
      runtime,
      now: () => new Date("2026-07-26T10:00:31.050Z"),
    });

    const first = await controller.submit(browserEvent());
    assert.equal(first.status, "invoked");
    assert.deepEqual(first.captured_views.map(item => item.role), ["current_page", "current_selection"]);
    assert.equal(first.matched_automations[0]?.view_id, "automation:github-summary");
    assert.equal(first.invocations[0]?.status, "succeeded");
    assert.equal(targetRequests.length, 1);
    assert.deepEqual(targetRequests[0]?.context.bindings.map(binding => [binding.role, binding.views[0]?.schema.name]), [
      ["current_page", "capture.browser.page_snapshot"],
      ["current_selection", "capture.browser.selection"],
    ]);
    assert.deepEqual(targetRequests[0]?.occurrence.evidence, first.captured_views.map(item => item.ref));
    assert.deepEqual(deliveries, ["result"]);

    const duplicate = await controller.submit(browserEvent());
    assert.equal(duplicate.invocations[0]?.status, "duplicate");
    assert.equal(targetRequests.length, 1);

    const laterSnapshot = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:github:mutation-2",
      captured_at: "2026-07-26T10:00:32.000Z",
      page: { ...browserEvent().page, text: `${browserEvent().page.text} DOM mutation.` },
    });
    assert.equal(laterSnapshot.invocations[0]?.status, "skipped");
    assert.equal(laterSnapshot.invocations[0]?.reason, "cooldown");
    assert.equal(targetRequests.length, 1);
    assert.equal((await views.query({ schema_name: "capture.browser.page_snapshot", revisions: "all", limit: 10 })).length, 2);
  } finally {
    occurrences.close();
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Browser adapter does not capture full text when no enabled Automation matches", async () => {
  let captures = 0;
  let invocations = 0;
  const controller = new BrowserAutomationController({
    capture: { async submitAutomationEvidence() { captures += 1; throw new Error("must not capture"); } },
    catalog: { async list() { return []; } },
    runtime: { async invoke() { invocations += 1; throw new Error("must not invoke"); } },
  });
  const result = await controller.submit(browserEvent());
  assert.equal(result.status, "ignored");
  assert.equal(captures, 0);
  assert.equal(invocations, 0);
  assert.deepEqual(result.captured_views, []);
});

test("matched Browser Automation fails when exact evidence has do_not_store policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-browser-private-"));
  const views = new SqliteViewRepository(join(directory, "views.sqlite"));
  try {
    await views.commit({ draft: automationDraft(), expected_revision: 0 });
    const controller = new BrowserAutomationController({
      capture: { async submitAutomationEvidence() { throw new Error("policy must fail before Browser Capture"); } },
      catalog: new ViewBrowserAutomationCatalog(views),
      runtime: { async invoke() { throw new Error("policy must fail before invocation"); } },
    });
    await assert.rejects(
      controller.submit({
        ...browserEvent(),
        policy: { ...viewPolicy(), retention: "do_not_store" },
      }),
      (error: unknown) => error instanceof BrowserAutomationAdapterError && error.code === "required_evidence_not_stored",
    );
  } finally {
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Browser Delivery mailbox is idempotent and rejects conflicting replay", async () => {
  const mailbox = new BrowserDeliveryMailbox(() => new Date("2026-07-26T10:01:00.000Z"));
  const request = {
    id: "delivery-request:github:1",
    correlation_id: "occurrence:github:1",
    phase: "result" as const,
    surface: "browser",
    urgency: "glance" as const,
    replacement: "replace" as const,
    actions: ["accept", "dismiss"] as Array<"accept" | "dismiss">,
    automation: { view_id: "automation:github-summary", revision: 1 },
    occurrence_id: "occurrence:github:1",
    run_id: "run:github:1",
    views: [{ view_id: "view:github-summary", revision: 1 }],
  };
  const first = await mailbox.render(request);
  const replay = await mailbox.render(request);
  assert.deepEqual(replay, first);
  assert.equal(mailbox.list().length, 1);
  await assert.rejects(
    mailbox.render({ ...request, views: [{ view_id: "view:other", revision: 1 }] }),
    /delivery id conflict/,
  );
  await mailbox.withdraw({ delivery_id: first.delivery_id, request_id: request.id, reason: "interaction" });
  assert.equal(mailbox.list().length, 0);
});

test("Browser interaction bridge derives policy from the exact Automation View", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-browser-interaction-"));
  const views = new SqliteViewRepository(join(directory, "views.sqlite"));
  const ledger = new InMemoryAutomationDeliveryLedger();
  const mailbox = new BrowserDeliveryMailbox();
  try {
    const automation = await views.commit({ draft: automationDraft(), expected_revision: 0 });
    const request = {
      id: "delivery-request:github:feedback",
      correlation_id: "occurrence:github:feedback",
      phase: "result" as const,
      surface: "browser",
      urgency: "glance" as const,
      replacement: "replace" as const,
      actions: ["accept"] as Array<"accept">,
      automation: { view_id: automation.view.id, revision: automation.view.revision },
      occurrence_id: "occurrence:github:feedback",
      run_id: "run:github:feedback",
      views: [{ view_id: "view:github-summary", revision: 1 }],
    };
    const rendered = await mailbox.render(request);
    await ledger.record({
      request,
      result: { status: "delivered", delivery_id: rendered.delivery_id },
      recorded_at: "2026-07-26T10:02:00.000Z",
    });
    let receivedPolicy: unknown;
    const bridge = new BrowserAutomationHttpBridge({
      controller: { async submit() { throw new Error("unused"); } },
      mailbox,
      ledger,
      views,
      delivery: {
        async interact(input) {
          receivedPolicy = input.policy;
          return {
            feedback_view: { view_id: "feedback:browser:1", revision: 1 },
            replayed: false,
            command: { status: "not_applicable" as const },
          };
        },
      },
    });
    const result = await bridge.interact({
      id: "interaction:browser:accept:1",
      request_id: request.id,
      delivery_id: rendered.delivery_id,
      surface: "browser",
      action: "accept",
      occurred_at: "2026-07-26T10:02:01.000Z",
      actor: "user:local",
      metadata: {},
    });
    assert.deepEqual(receivedPolicy, automation.view.policy);
    assert.deepEqual(result.feedback_view, { view_id: "feedback:browser:1", revision: 1 });
  } finally {
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function automationDraft() {
  const definition = parseAutomationDefinition({
    version: 1,
    enabled: true,
    trigger: {
      id: "github-summary",
      kind: "event",
      source: "chrome-extension",
      event: "browser.page_state",
      predicate: {
        type: "all",
        predicates: [
          { type: "field", path: "url", operator: "matches", value: "^https://github\\.com/[^/]+/[^/]+" },
          { type: "field", path: "dwell_ms", operator: "gte", value: 30000 },
          { type: "field", path: "dom.github_repository", operator: "eq", value: true },
        ],
      },
    },
    target: { kind: "transformation", transformation_id: "transformation.github.summary", revision: 1 },
    input_mapping: [
      {
        role: "current_page",
        required: true,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "chrome-extension" }],
      },
      {
        role: "current_selection",
        required: false,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.selection", source: "chrome-extension" }],
      },
    ],
    delivery: [{ surface: "browser", urgency: "glance", actions: ["accept", "dismiss", "later"] }],
    limits: { dedupe_window_ms: 90000, cooldown_ms: 90000, max_concurrency: 1, timeout_ms: 60000 },
  });
  return parseViewDraft({
    id: "automation:github-summary",
    name: "Summarize GitHub repositories",
    purpose: "Summarize a GitHub repository after declared dwell and DOM conditions",
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    role: "derived",
    time: { created_at: "2026-07-26T10:00:00.000Z" },
    representation: { form: "inline", kind: "automation", media_type: "application/json", value: definition },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: { inputs: [], actor: "user" },
    policy: viewPolicy(),
  });
}

function browserEvent() {
  return {
    version: 1 as const,
    event_id: "browser-event:github:1",
    navigation_id: "navigation:tab-42:openai-codex",
    tab_id: 42,
    window_id: 7,
    occurred_at: "2026-07-26T10:00:31.000Z",
    captured_at: "2026-07-26T10:00:31.050Z",
    reason: "dwell" as const,
    url: "https://github.com/openai/codex",
    title: "GitHub - openai/codex",
    domain: "github.com",
    dwell_ms: 31000,
    scroll_depth: 0.62,
    scroll_events: 4,
    selection_count: 1,
    dom: {
      github_repository: true,
      repository_owner: "openai",
      repository_name: "codex",
      markers: { repository_header: true },
    },
    page: {
      text: "Codex is a coding agent. Install it and use it in your terminal.",
      selected_text: "Codex is a coding agent.",
      metadata: { canonical_url: "https://github.com/openai/codex" },
      text_quality: { word_count: 14 },
    },
    source: { connector: "chrome-extension", connection_id: "chrome:profile-1" },
    policy: viewPolicy(),
  };
}

function viewPolicy() {
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutomationDeliveryCoordinator,
  AutomationDeliveryError,
  AutomationFeedbackViewService,
  InMemoryAutomationDeliveryLedger,
  InMemoryAutomationTraceStore,
  type AutomationDeliveryAction,
  type AutomationDeliveryRequest,
  type AutomationSurfaceRenderer,
} from "../packages/automation/index.ts";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";
import { SqliteAutomationDeliveryLedger } from "../packages/adapters/automation-sqlite/index.ts";

test("single-capacity notch replaces or suppresses deterministically", async () => {
  const notch = new FakeRenderer("notch", "single");
  const coordinator = coordinatorFor([notch]);

  const first = await coordinator.deliver(deliveryRequest({ id: "request:first", replacement: "replace" }));
  assert.equal(first.status, "delivered");
  const second = await coordinator.deliver(deliveryRequest({ id: "request:second", replacement: "replace" }));
  assert.equal(second.status, "delivered");
  if (second.status === "delivered") assert.equal(second.replaced_request_id, "request:first");
  assert.deepEqual(notch.withdrawals, [{ delivery_id: "notch:1", request_id: "request:first", reason: "replaced" }]);
  assert.equal(coordinator.activeRequest("notch")?.id, "request:second");

  const kept = await coordinator.deliver(deliveryRequest({ id: "request:third", replacement: "keep_existing" }));
  assert.deepEqual(kept, { status: "suppressed", reason: "surface_occupied", active_request_id: "request:second" });
  assert.equal(notch.rendered.length, 2);
});

test("expiry and unavailable surfaces are explicit while browser and inbox remain independent", async () => {
  const browser = new FakeRenderer("browser", "multiple");
  const inbox = new FakeRenderer("inbox", "multiple");
  const coordinator = coordinatorFor([browser, inbox]);

  const expired = await coordinator.deliver(deliveryRequest({
    id: "request:expired",
    surface: "browser",
    expires_at: "2026-07-26T08:59:59.000Z",
  }));
  assert.deepEqual(expired, { status: "expired", expired_at: "2026-07-26T08:59:59.000Z" });
  assert.equal(browser.rendered.length, 0);

  const unavailable = await coordinator.deliver(deliveryRequest({ id: "request:panel", surface: "panel" }));
  assert.deepEqual(unavailable, { status: "unavailable", error: "Delivery surface is unavailable: panel" });

  assert.equal((await coordinator.deliver(deliveryRequest({ id: "request:browser", surface: "browser" }))).status, "delivered");
  assert.equal((await coordinator.deliver(deliveryRequest({ id: "request:inbox", surface: "inbox", urgency: "background" }))).status, "delivered");
  assert.equal(browser.rendered.length, 1);
  assert.equal(inbox.rendered.length, 1);
});

test("interaction withdraws a multiple-capacity Browser card once", async () => {
  const browser = new FakeRenderer("browser", "multiple");
  const coordinator = coordinatorFor([browser]);
  const request = deliveryRequest({ id: "request:browser-feedback", surface: "browser", actions: ["accept"] });
  const delivered = await coordinator.deliver(request);
  assert.equal(delivered.status, "delivered");
  if (delivered.status !== "delivered") return;

  const interaction = {
    ...interactionFor("accept", delivered.delivery_id),
    id: "interaction:browser-feedback",
    request_id: request.id,
    surface: "browser",
  };
  const first = await coordinator.interact({ interaction, policy: viewPolicy() });
  assert.equal(first.command.status, "not_applicable");
  assert.deepEqual(browser.withdrawals, [{
    delivery_id: delivered.delivery_id,
    request_id: request.id,
    reason: "interaction",
  }]);

  const replay = await coordinator.interact({ interaction, policy: viewPolicy() });
  assert.equal(replay.command.status, "not_applicable");
  assert.equal(browser.withdrawals.length, 1);
});

test("all Delivery actions commit exact Feedback Views and replay commands only once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-feedback-"));
  const views = new SqliteViewRepository(join(directory, "views.sqlite"));
  const notch = new FakeRenderer("notch", "single");
  const commands: AutomationDeliveryAction[] = [];
  try {
    await views.commit({ draft: viewDraft("automation:ambient:test", "metaflow.automation"), expected_revision: 0 });
    await views.commit({ draft: viewDraft("view:ambient:result", "analysis.ambient_answer"), expected_revision: 0 });
    const coordinator = new AutomationDeliveryCoordinator({
      renderers: [notch],
      ledger: new InMemoryAutomationDeliveryLedger(),
      events: new InMemoryAutomationTraceStore(),
      feedback: new AutomationFeedbackViewService(views),
      commands: {
        async handle(input) {
          if (!commands.includes(input.interaction.action)) commands.push(input.interaction.action);
          return { status: "handled", command_id: `command:${input.interaction.id}` };
        },
      },
      now: () => new Date("2026-07-26T09:00:00.000Z"),
    });
    const request = deliveryRequest({
      id: "request:feedback",
      phase: "result",
      run_id: "run:ambient:feedback",
      views: [{ view_id: "view:ambient:result", revision: 1 }],
      actions: ["accept", "dismiss", "later", "cancel", "retry", "correct"],
    });
    const delivered = await coordinator.deliver(request);
    assert.equal(delivered.status, "delivered");
    if (delivered.status !== "delivered") return;

    const actions = request.actions;
    for (const action of actions) {
      const result = await coordinator.interact({
        interaction: interactionFor(action, delivered.delivery_id),
        policy: viewPolicy(),
      });
      assert.equal(result.replayed, false);
      assert.equal(result.command.status, "handled");
    }

    const feedback = await views.query({ schema_name: "metaflow.automation.feedback", revisions: "all", limit: 20 });
    assert.equal(feedback.length, 6);
    for (const view of feedback) {
      assert.deepEqual(view.provenance.inputs, [
        { view_id: "automation:ambient:test", revision: 1 },
        { view_id: "view:ambient:result", revision: 1 },
      ]);
      assert.equal(view.relations.some(relation => relation.type === "feedback_for_result"), true);
      assert.equal(view.metadata.correlation_id, "occurrence:ambient:feedback");
      assert.equal(view.metadata.run_id, "run:ambient:feedback");
    }
    assert.deepEqual(commands, actions);

    const replay = await coordinator.interact({
      interaction: interactionFor("accept", delivered.delivery_id),
      policy: viewPolicy(),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.command.status, "handled");
    assert.deepEqual(commands, actions);
  } finally {
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persisted Delivery history accepts interaction after coordinator restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-delivery-restart-"));
  const ledgerPath = join(directory, "automation.sqlite");
  const viewPath = join(directory, "views.sqlite");
  const views = new SqliteViewRepository(viewPath);
  const firstLedger = new SqliteAutomationDeliveryLedger(ledgerPath);
  const notch = new FakeRenderer("notch", "single");
  try {
    await views.commit({ draft: viewDraft("automation:ambient:test", "metaflow.automation"), expected_revision: 0 });
    await views.commit({ draft: viewDraft("view:ambient:result", "analysis.ambient_answer"), expected_revision: 0 });
    const first = new AutomationDeliveryCoordinator({
      renderers: [notch],
      ledger: firstLedger,
      events: new InMemoryAutomationTraceStore(),
      feedback: new AutomationFeedbackViewService(views),
      commands: { async handle() { return { status: "not_applicable" }; } },
      now: () => new Date("2026-07-26T09:00:00.000Z"),
    });
    const delivered = await first.deliver(deliveryRequest({ id: "request:restart", actions: ["accept"] }));
    assert.equal(delivered.status, "delivered");
    if (delivered.status !== "delivered") return;
    firstLedger.close();

    const reopenedLedger = new SqliteAutomationDeliveryLedger(ledgerPath);
    try {
      const restarted = new AutomationDeliveryCoordinator({
        renderers: [new FakeRenderer("notch", "single")],
        ledger: reopenedLedger,
        events: new InMemoryAutomationTraceStore(),
        feedback: new AutomationFeedbackViewService(views),
        commands: { async handle() { return { status: "handled", command_id: "command:restart" }; } },
      });
      const result = await restarted.interact({
        interaction: {
          ...interactionFor("accept", delivered.delivery_id),
          id: "interaction:restart",
          request_id: "request:restart",
        },
        policy: viewPolicy(),
      });
      assert.equal(result.replayed, false);
      assert.deepEqual(result.command, { status: "handled", command_id: "command:restart" });
      const feedback = await views.get({ view_id: "automation-feedback:interaction:restart", revision: 1 });
      assert.equal(feedback?.metadata.occurrence_id, "occurrence:ambient:feedback");
    } finally {
      reopenedLedger.close();
    }
  } finally {
    firstLedger.close();
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid or mismatched interactions fail before feedback", async () => {
  const notch = new FakeRenderer("notch", "single");
  const coordinator = coordinatorFor([notch]);
  const delivered = await coordinator.deliver(deliveryRequest({ id: "request:interaction", actions: ["accept", "later", "correct"] }));
  assert.equal(delivered.status, "delivered");
  if (delivered.status !== "delivered") return;

  await assert.rejects(
    coordinator.interact({ interaction: interactionFor("later", delivered.delivery_id, { snooze_until: undefined }), policy: viewPolicy() }),
    (error: unknown) => error instanceof AutomationDeliveryError && error.code === "invalid_interaction",
  );
  await assert.rejects(
    coordinator.interact({ interaction: interactionFor("correct", delivered.delivery_id, { correction: undefined }), policy: viewPolicy() }),
    (error: unknown) => error instanceof AutomationDeliveryError && error.code === "invalid_interaction",
  );
  await assert.rejects(
    coordinator.interact({ interaction: { ...interactionFor("accept", delivered.delivery_id), request_id: "request:other" }, policy: viewPolicy() }),
    (error: unknown) => error instanceof AutomationDeliveryError && error.code === "interaction_mismatch",
  );
});

class FakeRenderer implements AutomationSurfaceRenderer {
  readonly rendered: AutomationDeliveryRequest[] = [];
  readonly withdrawals: Array<{ delivery_id: string; request_id: string; reason: "replaced" | "expired" | "interaction" }> = [];

  constructor(readonly surface: string, readonly capacity: "single" | "multiple") {}

  async render(request: AutomationDeliveryRequest) {
    this.rendered.push(request);
    return { delivery_id: `${this.surface}:${this.rendered.length}` };
  }

  async withdraw(input: { delivery_id: string; request_id: string; reason: "replaced" | "expired" | "interaction" }) {
    this.withdrawals.push(input);
  }
}

function coordinatorFor(renderers: AutomationSurfaceRenderer[]) {
  return new AutomationDeliveryCoordinator({
    renderers,
    ledger: new InMemoryAutomationDeliveryLedger(),
    events: new InMemoryAutomationTraceStore(),
    feedback: {
      async record() {
        return { feedback_view: { view_id: "feedback:test", revision: 1 }, created: true };
      },
    },
    commands: { async handle() { return { status: "not_applicable" }; } },
    now: () => new Date("2026-07-26T09:00:00.000Z"),
  });
}

function deliveryRequest(overrides: Partial<AutomationDeliveryRequest> = {}): AutomationDeliveryRequest {
  return {
    id: "request:default",
    correlation_id: "occurrence:ambient:feedback",
    phase: "result",
    surface: "notch",
    urgency: "glance",
    replacement: "replace",
    expires_at: "2026-07-26T09:10:00.000Z",
    actions: ["accept", "dismiss"],
    automation: { view_id: "automation:ambient:test", revision: 1 },
    occurrence_id: "occurrence:ambient:feedback",
    run_id: "run:ambient:feedback",
    views: [{ view_id: "view:ambient:result", revision: 1 }],
    ...overrides,
  };
}

function interactionFor(
  action: AutomationDeliveryAction,
  deliveryId: string,
  overrides: { snooze_until?: string; correction?: string } = {},
) {
  return {
    id: `interaction:${action}`,
    request_id: "request:feedback",
    delivery_id: deliveryId,
    surface: "notch",
    action,
    occurred_at: "2026-07-26T09:01:00.000Z",
    actor: "user:local",
    ...(action === "later" ? { snooze_until: "2026-07-26T10:00:00.000Z" } : {}),
    ...(action === "correct" ? { correction: "Use the selected paragraph only." } : {}),
    ...overrides,
  };
}

function viewDraft(id: string, schema: string) {
  return {
    id,
    name: schema,
    purpose: "Automation Delivery test fixture",
    schema: { name: schema, version: 1, mode: "freeform" as const },
    role: "derived" as const,
    time: { created_at: "2026-07-26T08:59:00.000Z" },
    representation: { form: "inline" as const, kind: "json", value: { id } },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" as const } },
    },
    provenance: { inputs: [], actor: "test" },
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

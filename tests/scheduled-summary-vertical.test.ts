import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "../packages/adapters/agent-runtime/types.ts";
import { parseViewDraft } from "../packages/view/index.ts";

test("scheduled period freezes exact activity, executes through ACP, delivers inbox, and records feedback trace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduled-summary-"));
  const agent = new DailySummaryAgent();
  const now = () => new Date("2026-07-26T16:00:10.000Z");
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: agent,
    now,
  });
  try {
    const inside = await composition.views.commit({
      draft: activityView({
        id: "activity:inside-period",
        observed_at: "2026-07-26T08:30:00.000Z",
        text: "Worked on the scheduler and made the period boundary explicit.",
      }),
      expected_revision: 0,
    });
    await composition.views.commit({
      draft: activityView({
        id: "activity:period-end",
        observed_at: "2026-07-26T16:00:00.000Z",
        text: "This belongs to the next half-open period.",
      }),
      expected_revision: 0,
    });
    await composition.views.commit({
      draft: activityView({
        id: "activity:wrong-category",
        schema: "capture.calendar.event",
        observed_at: "2026-07-26T09:00:00.000Z",
        text: "This category is not declared by the daily summary.",
      }),
      expected_revision: 0,
    });

    const tick = await composition.scheduler.tick();
    assert.equal(tick.schedules, 1);
    assert.equal(tick.periods.length, 1);
    const invocation = tick.periods[0]!;
    assert.equal(invocation.result.status, "succeeded");
    assert.equal(agent.calls.length, 1);
    const projected = JSON.stringify(agent.calls[0]!.task.currentContext);
    assert.match(projected, /Worked on the scheduler/);
    assert.doesNotMatch(projected, /next half-open period/);
    assert.doesNotMatch(projected, /category is not declared/);
    assert.match(projected, new RegExp(`${inside.view.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*revision`, "s"));

    const result = invocation.result;
    if (result.status !== "succeeded") return;
    const summary = await composition.views.get(result.output_views[0]!);
    assert.equal(summary?.schema.name, "summary.ambient.daily");
    assert.deepEqual(summary?.provenance.inputs, [{ view_id: inside.view.id, revision: inside.view.revision }]);

    const inboxResponse = await request(composition.handler, "GET", "/automation/v1/inbox/deliveries");
    assert.equal(inboxResponse.status, 200);
    const inbox = inboxResponse.body.deliveries as ReturnType<typeof composition.inboxMailbox.list>;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.request.phase, "result");
    assert.deepEqual(inbox[0]?.request.views, result.output_views);
    assert.deepEqual(inbox[0]?.request.actions, ["accept", "dismiss", "retry", "correct"]);

    const automation = await composition.views.get(inbox[0]!.request.automation);
    assert.ok(automation);
    const retryResponse = await request(composition.handler, "POST", "/automation/v1/inbox/interactions", {
        id: "interaction:daily-summary:retry:1",
        request_id: inbox[0]!.request.id,
        delivery_id: inbox[0]!.delivery_id,
        surface: "inbox",
        action: "retry",
        occurred_at: "2026-07-26T16:02:00.000Z",
        actor: "user:local",
        metadata: { reason: "The summary missed one decision" },
    });
    assert.equal(retryResponse.status, 200);
    assert.equal(retryResponse.body.result.replayed, false);
    const correction = await composition.delivery.interact({
      interaction: {
        id: "interaction:daily-summary:correct:1",
        request_id: inbox[0]!.request.id,
        delivery_id: inbox[0]!.delivery_id,
        surface: "inbox",
        action: "correct",
        correction: "Call this the Scheduler adapter, not the timer service.",
        occurred_at: "2026-07-26T16:03:00.000Z",
        actor: "user:local",
        metadata: {},
      },
      policy: automation!.policy,
    });
    assert.equal(correction.replayed, false);

    const feedbackViews = await composition.views.query({
      schema_name: "metaflow.automation.feedback",
      revisions: "all",
      limit: 10,
    });
    assert.equal(feedbackViews.length, 2);
    assert.ok(feedbackViews.every(view => view.provenance.inputs.some(ref => ref.view_id === summary?.id)));

    const trace = await composition.traces.query({ correlation_id: result.correlation_id });
    const occurrence = trace.find(event => event.type === "automation.occurrence_received");
    assert.match(JSON.stringify(occurrence?.payload), /2026-07-25T16:00:00.000Z/);
    assert.match(JSON.stringify(occurrence?.payload), /2026-07-26T16:00:00.000Z/);
    for (const type of [
      "automation.context_resolved",
      "automation.run_started",
      "automation.agent_event",
      "automation.result_committed",
      "automation.delivery_succeeded",
      "automation.feedback_recorded",
      "automation.occurrence_completed",
    ]) {
      assert.ok(trace.some(event => event.type === type), `missing ${type}`);
    }
  } finally {
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class DailySummaryAgent implements AgentRuntimeAdapter {
  readonly id = "acp_stdio";
  readonly kind = "acp_stdio" as const;
  readonly calls: Array<{ task: AgentTaskRequest; context: AgentRuntimeContext }> = [];

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      modes: ["invoke" as const],
      supportsDryRun: false,
      supportsCancel: false,
      supportsPermissionRequests: false,
      supportsProgress: true,
      supportsMcpServers: false,
    };
  }

  async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    this.calls.push({ task, context });
    await context.events?.emit({
      type: "runtime.start",
      runtime: this.id,
      taskId: task.id,
      payload: { fixture: "scheduled-summary" },
    });
    return {
      ok: true,
      reason: "daily summary fixture completed",
      output: {
        summary: "The day focused on making scheduled periods exact and observable.",
        themes: ["Ambient", "Scheduler"],
        unfinished: ["Expose the inbox in a user-facing surface"],
      },
      diagnostics: { runtime: this.id, fixture: true },
    };
  }
}

function activityView(input: {
  id: string;
  observed_at: string;
  text: string;
  schema?: string;
}) {
  return parseViewDraft({
    id: input.id,
    name: input.id,
    purpose: "Scheduled summary input fixture",
    schema: { name: input.schema ?? "capture.browser.page_snapshot", version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: input.observed_at, created_at: input.observed_at },
    representation: { form: "inline", kind: "document", value: { text: input.text } },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      trace_id: `trace:${input.id}`,
      capture: {
        connector: "test-activity",
        connection_id: "test-activity:default",
        source_id: input.id,
        source_kind: "test",
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: true,
      allow_embedding: false,
      labels: ["activity"],
    },
  });
}

async function request(
  handler: (req: any, res: any) => Promise<void>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    authorization: "Bearer test-operation-auth-token-32-bytes",
  };
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { raw = value; },
  };
  await handler(req, res);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

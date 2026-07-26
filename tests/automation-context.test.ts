import test from "node:test";
import assert from "node:assert/strict";
import {
  AutomationContextResolutionError,
  AutomationContextResolver,
  createTriggerOccurrence,
  parseAutomationDefinition,
  parseAutomationView,
  parseTriggerSignal,
} from "../packages/automation/index.ts";
import { parseView, type View, type ViewQuery } from "@info/view";

test("Context resolution selects and authorizes exact trigger evidence and query Views", async () => {
  const browser = rawView({
    id: "view:browser:github",
    revision: 4,
    schema: "capture.browser.page_snapshot",
    connector: "chrome-extension",
    value: { url: "https://github.com/openai/codex", text: "Codex README" },
  });
  const project = derivedView({
    id: "view:project:info",
    revision: 7,
    schema: "project.current",
    value: { project_path: "/Users/junjie/info" },
  });
  const resolver = resolverFor([browser, project]);
  const { automation, occurrence } = fixture({
    input_mapping: [
      {
        role: "current_page",
        required: true,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "chrome-extension" }],
      },
      {
        role: "current_project",
        required: false,
        sources: [{ kind: "view_query", schema_name: "project.current", limit: 1 }],
      },
    ],
    evidence: [{ view_id: browser.id, revision: browser.revision }],
  });

  const result = await resolver.resolve({ automation, occurrence });
  assert.deepEqual(result.disclosed_views, [
    { view_id: browser.id, revision: 4 },
    { view_id: project.id, revision: 7 },
  ]);
  assert.equal(result.bindings[0]?.views[0]?.representation.form, "inline");
  assert.deepEqual(result.attempts.map(attempt => attempt.status), ["selected", "selected"]);
});

test("Context alternatives are ordered and every failed attempt stays in trace", async () => {
  const ax = rawView({
    id: "view:ax-selection",
    revision: 2,
    schema: "capture.local_app.selection",
    connector: "mac",
    value: { selected_text: "Ambient is an Automation." },
  });
  const resolver = resolverFor([ax]);
  const { automation, occurrence } = fixture({
    input_mapping: [{
      role: "current_screen",
      required: true,
      sources: [
        { kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "chrome-extension" },
        { kind: "view_ref", ref: { view_id: ax.id, revision: ax.revision } },
      ],
    }],
    evidence: [{ view_id: ax.id, revision: ax.revision }],
  });

  const result = await resolver.resolve({ automation, occurrence });
  assert.deepEqual(result.attempts.map(attempt => attempt.status), ["empty", "selected"]);
  assert.deepEqual(result.disclosed_views, [{ view_id: ax.id, revision: 2 }]);
});

test("Denied required context fails before disclosure and preserves the policy decision", async () => {
  const sensitive = rawView({
    id: "view:screen:sensitive",
    revision: 1,
    schema: "capture.local_app.selection",
    connector: "mac",
    value: { selected_text: "secret" },
    privacy: "sensitive",
  });
  const views = repositoryFor([sensitive]);
  const resolver = new AutomationContextResolver({
    views,
    authorizer: {
      async authorize({ view }) {
        return view.policy.privacy === "sensitive"
          ? { allowed: false, decision_id: "policy:deny-sensitive", reason: "sensitive Views require explicit approval" }
          : { allowed: true, decision_id: "policy:allow", reason: "allowed" };
      },
    },
  });
  const { automation, occurrence } = fixture({
    input_mapping: [{
      role: "current_screen",
      required: true,
      sources: [{ kind: "view_ref", ref: { view_id: sensitive.id, revision: sensitive.revision } }],
    }],
    evidence: [],
  });

  await assert.rejects(
    resolver.resolve({ automation, occurrence }),
    (error: unknown) => {
      assert.ok(error instanceof AutomationContextResolutionError);
      assert.equal(error.code, "view_access_denied");
      assert.deepEqual(error.attempts[0]?.denied, [{
        ref: { view_id: sensitive.id, revision: 1 },
        decision_id: "policy:deny-sensitive",
        reason: "sensitive Views require explicit approval",
      }]);
      return true;
    },
  );
});

test("Missing exact evidence fails instead of drifting to a latest revision", async () => {
  const latest = rawView({
    id: "view:browser:github",
    revision: 5,
    schema: "capture.browser.page_snapshot",
    connector: "chrome-extension",
    value: { text: "newer page state" },
  });
  const resolver = resolverFor([latest]);
  const { automation, occurrence } = fixture({
    input_mapping: [{
      role: "current_page",
      required: true,
      sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot" }],
    }],
    evidence: [{ view_id: latest.id, revision: 4 }],
  });

  await assert.rejects(
    resolver.resolve({ automation, occurrence }),
    (error: unknown) => error instanceof AutomationContextResolutionError
      && error.code === "view_resolution_failed"
      && /github@4/.test(error.attempts[0]?.reason ?? ""),
  );
});

function resolverFor(views: View[]) {
  return new AutomationContextResolver({
    views: repositoryFor(views),
    authorizer: {
      async authorize() {
        return { allowed: true, decision_id: "policy:test-allow", reason: "test policy allows exact View" };
      },
    },
  });
}

function repositoryFor(views: View[]) {
  const byExact = new Map(views.map(view => [`${view.id}@${view.revision}`, view]));
  return {
    async get(ref: { view_id: string; revision: number }) {
      return byExact.get(`${ref.view_id}@${ref.revision}`);
    },
    async query(query: ViewQuery = {}) {
      return views
        .filter(view => !query.schema_name || view.schema.name === query.schema_name)
        .filter(view => !query.role || view.role === query.role)
        .filter(view => !query.text || JSON.stringify(view.representation).includes(query.text))
        .slice(0, query.limit ?? 100);
    },
  };
}

function fixture(input: {
  input_mapping: unknown[];
  evidence: Array<{ view_id: string; revision: number }>;
}) {
  const definition = parseAutomationDefinition({
    version: 1,
    trigger: { id: "ask", kind: "user", source: "mac", event: "push_to_talk.released" },
    target: { kind: "transformation", transformation_id: "transformation.ambient.ask", revision: 1 },
    input_mapping: input.input_mapping,
  });
  const automation = parseAutomationView(parseView({
    id: "automation:ask",
    revision: 3,
    name: "Ask from current context",
    purpose: "Invoke a Transformation from exact current context",
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    role: "derived",
    time: { created_at: "2026-07-26T09:00:00.000Z" },
    representation: { form: "inline", kind: "automation", value: definition },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: { inputs: [], actor: "user" },
    policy: basePolicy("private"),
  }));
  const signal = parseTriggerSignal({
    id: "signal:ask:1",
    kind: "user",
    source: "mac",
    event: "push_to_talk.released",
    occurred_at: "2026-07-26T09:01:00.000Z",
    idempotency_key: "shortcut:1",
    evidence: input.evidence,
  });
  const occurrence = createTriggerOccurrence({
    automation: { view_id: automation.view.id, revision: automation.view.revision },
    definition,
    signal,
  });
  return { automation, occurrence };
}

function rawView(input: {
  id: string;
  revision: number;
  schema: string;
  connector: string;
  value: Record<string, unknown>;
  privacy?: "public" | "private" | "sensitive";
}) {
  return parseView({
    id: input.id,
    revision: input.revision,
    name: input.schema,
    purpose: "Trigger-time source evidence",
    schema: { name: input.schema, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: "2026-07-26T09:00:00.000Z", created_at: "2026-07-26T09:00:00.000Z" },
    representation: { form: "inline", kind: "json", value: input.value },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: {
      inputs: [],
      actor: input.connector,
      capture: {
        connector: input.connector,
        connection_id: `${input.connector}:local`,
        source_id: input.id,
        source_kind: input.schema,
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: basePolicy(input.privacy ?? "private"),
  });
}

function derivedView(input: { id: string; revision: number; schema: string; value: Record<string, unknown> }) {
  return parseView({
    id: input.id,
    revision: input.revision,
    name: input.schema,
    purpose: "Derived current project context",
    schema: { name: input.schema, version: 1, mode: "freeform" },
    role: "derived",
    time: { created_at: "2026-07-26T08:59:00.000Z" },
    representation: { form: "inline", kind: "json", value: input.value },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: { inputs: [], actor: "transformation:test" },
    policy: basePolicy("private"),
  });
}

function basePolicy(privacy: "public" | "private" | "sensitive") {
  return {
    owner: "user:local",
    visibility: "private",
    privacy,
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

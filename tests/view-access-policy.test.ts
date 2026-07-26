import test from "node:test";
import assert from "node:assert/strict";
import {
  DeterministicViewAccessAuthorizer,
  ViewAccessAuthorizationRequestSchema,
  ViewAccessPolicySnapshotSchema,
  ViewPolicyInheritanceError,
  evaluateViewAccess,
  inheritStrictestViewPolicy,
  parseViewAccessPolicySnapshot,
  type ViewAccessPolicySnapshot,
  type ViewAccessRule,
} from "@info/execution";
import { canonicalJson, parseView, type View, type ViewPolicy } from "@info/view";
import { TransformationPolicySnapshotSchema, type OperatorSnapshot } from "@info/transformation";

const operator: OperatorSnapshot = {
  id: "operator:research-agent",
  revision: 4,
  reference: { kind: "agent", adapter: "codex-acp", profile: "researcher" },
  configuration: {},
  required_capabilities: ["view.read"],
};

function policy(
  profile: ViewAccessPolicySnapshot["configuration"]["profile"],
  rules: ViewAccessRule[] = [],
): ViewAccessPolicySnapshot {
  return parseViewAccessPolicySnapshot({
    id: `policy:${profile}`,
    revision: 3,
    configuration: { kind: "view_access", profile, rules },
  });
}

function view(options: {
  id?: string;
  revision?: number;
  privacy?: ViewPolicy["privacy"];
  allowExternal?: boolean;
  allowEmbedding?: boolean;
  schema?: string;
  owner?: string;
  capture?: {
    connector: string;
    connection_id: string;
    source_id: string;
    source_kind: string;
  };
} = {}): View {
  const id = options.id ?? "view:private-note";
  const capture = options.capture;
  return parseView({
    id,
    revision: options.revision ?? 1,
    name: id,
    purpose: "Exercise deterministic View disclosure policy",
    schema: { name: options.schema ?? "note.personal", version: 1, mode: "freeform" },
    role: capture ? "raw" : "derived",
    time: { created_at: "2026-07-26T06:00:00.000Z" },
    representation: { form: "inline", kind: "markdown", value: "policy evidence" },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    provenance: capture
      ? {
          inputs: [],
          actor: "capture-ingress",
          capture: { ...capture, identity: "occurrence", assertion: "direct" },
        }
      : { inputs: [], actor: "test", operator_run_id: "run:test" },
    policy: {
      owner: options.owner ?? "user:junjie",
      visibility: "private",
      privacy: options.privacy ?? "private",
      retention: "normal",
      allow_external_model: options.allowExternal ?? false,
      allow_embedding: options.allowEmbedding ?? false,
      labels: ["personal"],
    },
  });
}

test("Manual, Smart Approve, and Approve All have deterministic unmatched defaults", () => {
  const ordinary = view();
  const sensitive = view({ id: "view:sensitive", privacy: "sensitive" });

  assert.equal(evaluateViewAccess({ policy: policy("manual"), operator, use: "local_execution", views: [ordinary] }).outcome, "approval_required");
  assert.equal(evaluateViewAccess({ policy: policy("smart_approve"), operator, use: "local_execution", views: [ordinary] }).outcome, "allowed");
  assert.equal(evaluateViewAccess({ policy: policy("smart_approve"), operator, use: "local_execution", views: [sensitive] }).outcome, "approval_required");
  assert.equal(evaluateViewAccess({ policy: policy("approve_all"), operator, use: "local_execution", views: [sensitive] }).outcome, "allowed");
});

test("explicit allow can satisfy Manual, while any matching explicit deny wins", () => {
  const input = view();
  const allow: ViewAccessRule = {
    id: "allow:exact-note",
    effect: "allow",
    target: { kind: "view", ref: { view_id: input.id, revision: input.revision } },
    reason: "The user approved this exact revision",
  };
  const deny: ViewAccessRule = {
    id: "deny:personal-schema",
    effect: "deny",
    target: { kind: "schema", name: input.schema.name },
    reason: "Personal notes must not be disclosed to this Operator",
  };

  const allowed = evaluateViewAccess({ policy: policy("manual", [allow]), operator, use: "local_execution", views: [input] });
  assert.equal(allowed.outcome, "allowed");
  assert.equal(allowed.views[0]?.decisive.id, allow.id);

  const denied = evaluateViewAccess({ policy: policy("approve_all", [allow, deny]), operator, use: "local_execution", views: [input] });
  assert.equal(denied.outcome, "denied");
  assert.equal(denied.views[0]?.decisive.id, deny.id);
  assert.deepEqual(denied.allowed_views, []);
  assert.deepEqual(denied.denied_views, [{ view_id: input.id, revision: input.revision }]);
});

test("View hard constraints cannot be overridden by Approve All or an allow rule", () => {
  const input = view({ privacy: "public", allowExternal: false, allowEmbedding: false });
  const allow: ViewAccessRule = {
    id: "allow:all-research-agent",
    effect: "allow",
    target: { kind: "operator", operator_id: operator.id },
    reason: "The Operator is broadly trusted",
  };

  const external = evaluateViewAccess({ policy: policy("approve_all", [allow]), operator, use: "external_model", views: [input] });
  assert.equal(external.outcome, "denied");
  assert.equal(external.views[0]?.decisive.id, "view.policy.allow_external_model");

  const embedding = evaluateViewAccess({ policy: policy("approve_all", [allow]), operator, use: "embedding", views: [input] });
  assert.equal(embedding.outcome, "denied");
  assert.equal(embedding.views[0]?.decisive.id, "view.policy.allow_embedding");
});

test("View, source, Schema, and Operator deny rules retain exact provenance", () => {
  const browser = view({
    id: "view:browser:page",
    schema: "browser.page",
    capture: {
      connector: "browser",
      connection_id: "browser:default",
      source_id: "https://example.com/private",
      source_kind: "page",
    },
  });
  const rules: ViewAccessRule[] = [
    {
      id: "deny:source",
      effect: "deny",
      target: { kind: "source", connector: "browser", source_kind: "page" },
      reason: "Browser pages are excluded",
    },
    {
      id: "deny:schema",
      effect: "deny",
      target: { kind: "schema", name: "browser.page", version: 1 },
      reason: "The browser page Schema is excluded",
    },
    {
      id: "deny:view",
      effect: "deny",
      target: { kind: "view", ref: { view_id: browser.id, revision: browser.revision } },
      reason: "This exact page is excluded",
    },
    {
      id: "deny:operator",
      effect: "deny",
      target: { kind: "operator", operator_id: operator.id, revision: operator.revision },
      reason: "This exact Operator revision is excluded",
    },
  ];

  const decision = evaluateViewAccess({ policy: policy("approve_all", rules), operator, use: "local_execution", views: [browser] });
  assert.equal(decision.outcome, "denied");
  assert.deepEqual(
    decision.views[0]?.matched.filter(match => match.source === "explicit_rule").map(match => match.id),
    ["deny:operator", "deny:source", "deny:schema", "deny:view"],
  );
  assert.equal(decision.operator_matches[0]?.id, "deny:operator");
  assert.deepEqual(decision.allowed_views, []);
  assert.deepEqual(decision.denied_views, [{ view_id: browser.id, revision: browser.revision }]);

  const noInputDecision = evaluateViewAccess({ policy: policy("approve_all", rules), operator, use: "local_execution", views: [] });
  assert.equal(noInputDecision.outcome, "denied");
  assert.deepEqual(noInputDecision.denied_views, []);
});

test("mixed input decisions never permit a partial Run and preserve exact subsets", () => {
  const allowed = view({ id: "view:allowed" });
  const denied = view({ id: "view:denied", revision: 2 });
  const denyRule: ViewAccessRule = {
    id: "deny:exact",
    effect: "deny",
    target: { kind: "view", ref: { view_id: denied.id, revision: denied.revision } },
    reason: "This exact revision is excluded",
  };

  const decision = evaluateViewAccess({
    policy: policy("approve_all", [denyRule]),
    operator,
    use: "local_execution",
    views: [denied, allowed],
  });
  assert.equal(decision.outcome, "denied");
  assert.deepEqual(decision.allowed_views, [{ view_id: allowed.id, revision: allowed.revision }]);
  assert.deepEqual(decision.denied_views, [{ view_id: denied.id, revision: denied.revision }]);
});

test("policy snapshots and decisions round-trip with stable audit identity", async () => {
  const snapshot = policy("smart_approve", [{
    id: "allow:research",
    effect: "allow",
    target: { kind: "operator", operator_id: operator.id },
    reason: "Research Operator approved",
  }]);
  const inputA = view({ id: "view:a" });
  const inputB = view({ id: "view:b", revision: 2 });
  const roundTrip = parseViewAccessPolicySnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(TransformationPolicySnapshotSchema.parse(snapshot), snapshot);
  assert.deepEqual(roundTrip, snapshot);
  assert.equal(canonicalJson(roundTrip), canonicalJson(snapshot));

  const first = evaluateViewAccess({ policy: snapshot, operator, use: "local_execution", views: [inputB, inputA] });
  const second = await new DeterministicViewAccessAuthorizer().authorize({
    policy: roundTrip,
    operator,
    use: "local_execution",
    views: [inputA, inputB],
  });
  assert.equal(first.decision_id, second.decision_id);
  assert.deepEqual(first, second);
});

test("invalid rules and ambiguous requests fail before a policy decision", () => {
  assert.equal(ViewAccessPolicySnapshotSchema.safeParse({
    id: "policy:bad-source",
    revision: 1,
    configuration: {
      kind: "view_access",
      profile: "approve_all",
      rules: [{ id: "deny:source", effect: "deny", target: { kind: "source" }, reason: "invalid" }],
    },
  }).success, false);
  assert.equal(ViewAccessPolicySnapshotSchema.safeParse({
    id: "policy:duplicate",
    revision: 1,
    configuration: {
      kind: "view_access",
      profile: "approve_all",
      rules: [
        { id: "same", effect: "allow", target: { kind: "operator", operator_id: "one" }, reason: "one" },
        { id: "same", effect: "deny", target: { kind: "operator", operator_id: "two" }, reason: "two" },
      ],
    },
  }).success, false);

  const duplicate = view();
  assert.equal(ViewAccessAuthorizationRequestSchema.safeParse({
    policy: policy("approve_all"),
    operator,
    use: "local_execution",
    views: [duplicate, duplicate],
  }).success, false);
});

test("Failure and repair policy inheritance chooses every strictest field", () => {
  const inherited = inheritStrictestViewPolicy([
    {
      owner: "user:junjie",
      visibility: "public",
      privacy: "public",
      retention: "archive",
      allow_external_model: true,
      allow_embedding: true,
      allow_local_search: true,
      labels: ["public", "shared"],
    },
    {
      owner: "user:junjie",
      visibility: "private",
      privacy: "sensitive",
      retention: "session",
      allow_external_model: false,
      allow_embedding: true,
      allow_local_search: false,
      labels: ["private", "shared"],
    },
  ]);
  assert.deepEqual(inherited, {
    owner: "user:junjie",
    visibility: "private",
    privacy: "sensitive",
    retention: "session",
    allow_external_model: false,
    allow_embedding: true,
    allow_local_search: false,
    labels: ["private", "public", "shared"],
  });

  assert.throws(
    () => inheritStrictestViewPolicy([]),
    (error: unknown) => error instanceof ViewPolicyInheritanceError && error.code === "no_input_policies",
  );
  assert.throws(
    () => inheritStrictestViewPolicy([
      { ...inherited, owner: "user:one" },
      { ...inherited, owner: "user:two" },
    ]),
    (error: unknown) => error instanceof ViewPolicyInheritanceError && error.code === "mixed_owners",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  OperatorReferenceSchema,
  TransformationRevisionTransitionError,
  TransformationSchema,
  assertTransformationRevisionTransition,
  exactTransformationRef,
  parseTransformation,
  type OperatorReference,
  type Transformation,
} from "@info/transformation";
import { canonicalJson } from "@info/view";

const createdAt = "2026-07-26T03:30:00.000Z";

const operatorReferences: OperatorReference[] = [
  { kind: "agent", adapter: "codex-acp", profile: "researcher" },
  { kind: "workflow", workflow_id: "workflow:daily-summary", revision: 3 },
  { kind: "function", function_id: "function:merge-markdown", version: 2 },
  { kind: "model", provider: "openai", model: "gpt-5.6" },
  { kind: "human", channel: "inbox", role: "editor" },
  { kind: "remote_service", service: "notion", operation: "append_page", api_version: "2026-03" },
];

function transformation(overrides: Record<string, unknown> = {}): Transformation {
  return parseTransformation({
    id: "transformation:github-summary",
    revision: 1,
    name: "Summarize a GitHub repository",
    instruction: {
      format: "natural_language",
      text: "Summarize the repository architecture and the ideas useful to Metaflow.",
      language: "en",
      parameters: { detail: "concise" },
    },
    operator: {
      id: "operator:research-agent",
      revision: 4,
      reference: operatorReferences[0],
      configuration: { reasoning_effort: "high" },
      required_capabilities: ["view.search", "view.read"],
    },
    inputs: [{
      role: "repository",
      required: true,
      sources: [{ kind: "view", ref: { view_id: "view:github:openai-codex", revision: 8 } }],
    }],
    output: {
      schema: { name: "research.repository-summary", version: 1, mode: "freeform" },
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    created_at: createdAt,
    ...overrides,
  });
}

test("every Operator kind is a strict tagged executable reference", () => {
  for (const reference of operatorReferences) {
    assert.deepEqual(OperatorReferenceSchema.parse(JSON.parse(JSON.stringify(reference))), reference);
  }
  assert.equal(OperatorReferenceSchema.safeParse({ kind: "worker", worker_id: "old-worker" }).success, false);
  assert.equal(OperatorReferenceSchema.safeParse({ kind: "model", provider: "openai" }).success, false);
  assert.equal(OperatorReferenceSchema.safeParse({ kind: "function", function_id: "x", version: 1, code: "hidden" }).success, false);
});

test("a one-off natural-language Transformation is fully frozen without requiring inputs", () => {
  const oneOff = transformation({
    id: "transformation:one-off:brainstorm",
    instruction: { format: "natural_language", text: "Create three names for this project." },
    inputs: [],
    operator: {
      id: "operator:model:openai",
      revision: 1,
      reference: { kind: "model", provider: "openai", model: "gpt-5.6" },
    },
    output: {
      schema: { name: "brainstorm.names", version: 1, mode: "freeform" },
      schema_origin: "inferred",
      cardinality: { min: 1, max: 3 },
    },
  });
  assert.equal(oneOff.instruction.text, "Create three names for this project.");
  assert.equal(oneOff.output.schema_origin, "inferred");
  assert.deepEqual(oneOff.inputs, []);
});

test("input bindings mix exact View revisions and frozen selector snapshots", () => {
  const parsed = transformation({
    inputs: [
      {
        role: "current_page",
        sources: [{ kind: "view", ref: { view_id: "view:browser:page", revision: 12 } }],
      },
      {
        role: "project_history",
        required: false,
        sources: [{
          kind: "selector",
          selector: {
            id: "selector:metaflow-history",
            revision: 2,
            query: {
              scope: "matching",
              schema_names: ["project.activity"],
              roles: ["derived"],
              observed_from: "2026-07-01T00:00:00.000Z",
              revision_scope: "latest",
              order: "newest",
              limit: 50,
            },
          },
        }],
      },
    ],
  });
  assert.equal(parsed.inputs[0]?.sources[0]?.kind, "view");
  assert.equal(parsed.inputs[1]?.sources[0]?.kind, "selector");
  assert.equal(TransformationSchema.safeParse({
    ...parsed,
    inputs: [{ role: "unsafe", sources: [{ kind: "view", ref: { view_id: "view:moving" } }] }],
  }).success, false);
  assert.equal(TransformationSchema.safeParse({
    ...parsed,
    inputs: [{
      role: "empty-query",
      sources: [{
        kind: "selector",
        selector: { id: "selector:empty", revision: 1, query: { scope: "matching", limit: 10 } },
      }],
    }],
  }).success, false);
});

test("optional Trigger, policy, and budget are versioned frozen snapshots", () => {
  const parsed = transformation({
    trigger: {
      id: "trigger:daily",
      revision: 2,
      kind: "schedule",
      configuration: { cron: "0 20 * * *", timezone: "Asia/Shanghai" },
    },
    policy: {
      id: "policy:personal-private",
      revision: 5,
      configuration: { approval: "smart", deny_sources: ["password-manager"] },
    },
    budget: {
      id: "budget:small-research",
      revision: 3,
      limits: { timeout_ms: 120_000, max_attempts: 2, max_cost_usd: 0.5 },
      extensions: { max_tool_calls: 20 },
    },
  });
  assert.equal(parsed.trigger?.revision, 2);
  assert.equal(parsed.policy?.revision, 5);
  assert.equal(parsed.budget?.revision, 3);
  assert.equal(TransformationSchema.safeParse({
    ...parsed,
    budget: { id: "budget:empty", revision: 1, limits: {} },
  }).success, false);
});

test("Transformation revisions preserve identity and exact supersession", () => {
  const first = transformation();
  const second = transformation({
    revision: 2,
    instruction: { format: "natural_language", text: "Focus on extension points and tradeoffs." },
    supersedes: exactTransformationRef(first),
    created_at: "2026-07-26T03:31:00.000Z",
  });
  assert.doesNotThrow(() => assertTransformationRevisionTransition(first, second));

  const sameRevisionMutation = transformation({
    instruction: { format: "natural_language", text: "Hidden same-revision mutation" },
  });
  assert.throws(
    () => assertTransformationRevisionTransition(first, sameRevisionMutation),
    (error: unknown) => error instanceof TransformationRevisionTransitionError
      && error.code === "revision_not_sequential",
  );

  const renamed = transformation({
    id: "transformation:renamed",
    revision: 2,
    supersedes: { transformation_id: "transformation:renamed", revision: 1 },
  });
  assert.throws(
    () => assertTransformationRevisionTransition(first, renamed),
    (error: unknown) => error instanceof TransformationRevisionTransitionError
      && error.code === "identity_changed",
  );
});

test("strict Transformation snapshots reject mutable Run state and unresolved output", () => {
  const valid = transformation();
  for (const forbidden of [
    { status: "running" },
    { run_id: "run:1" },
    { resolved_inputs: [{ view_id: "view:x", revision: 1 }] },
    { result: { status: "succeeded" } },
  ]) {
    assert.equal(TransformationSchema.safeParse({ ...valid, ...forbidden }).success, false);
  }
  const { output: _output, ...withoutOutput } = valid;
  assert.equal(TransformationSchema.safeParse(withoutOutput).success, false);
});

test("Operator snapshots are reusable and serialization is canonical", () => {
  const first = transformation();
  const second = transformation({
    id: "transformation:github-learning-material",
    name: "Extract English learning material",
    instruction: { format: "natural_language", text: "Extract useful English expressions." },
  });
  assert.deepEqual(first.operator, second.operator);
  assert.deepEqual(first.inputs[0], second.inputs[0]);
  assert.notEqual(first.id, second.id);

  const roundTrip = parseTransformation(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(roundTrip, first);
  assert.equal(canonicalJson(roundTrip), canonicalJson(first));
});

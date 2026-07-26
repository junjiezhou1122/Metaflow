import test from "node:test";
import assert from "node:assert/strict";
import {
  ViewRevisionTransitionError,
  ViewValidationError,
  assertViewRevisionTransition,
  canonicalJson,
  exactViewRef,
  parseView,
  parseViewDraft,
  representationSemanticValue,
  viewRevisionKey,
  type View,
  type ViewDraft,
} from "@info/view";

const createdAt = "2026-07-26T00:00:00.000Z";

test("canonical JSON is locale-independent and rejects non-JSON values", () => {
  assert.equal(canonicalJson({ "ä": 1, z: 2, a: 3 }), "{\"a\":3,\"z\":2,\"ä\":1}");
  assert.throws(() => canonicalJson({ unsupported: undefined }), TypeError);
});

function materialization() {
  return {
    primary: {
      id: "canonical-json",
      format: "json",
      media_type: "application/json",
      location: { kind: "inline" as const },
    },
  };
}

function policy() {
  return {
    owner: "user:test",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

function derivedDraft(overrides: Record<string, unknown> = {}): ViewDraft {
  return parseViewDraft({
    id: "view:project:summary",
    name: "Project summary",
    purpose: "Keep the current project summary useful for planning",
    schema: { name: "project.summary", version: 1, mode: "freeform" },
    role: "derived",
    time: { created_at: createdAt },
    representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: "# Project" },
    materialization: materialization(),
    provenance: { inputs: [], actor: "user:test" },
    policy: policy(),
    ...overrides,
  });
}

function committed(draft: ViewDraft, revision = 1): View {
  return parseView({ ...draft, revision });
}

function rawDraft(identity: "stable_source" | "occurrence", overrides: Record<string, unknown> = {}): ViewDraft {
  return parseViewDraft({
    id: identity === "stable_source" ? "view:raw:github-repository" : "view:raw:copy:1",
    name: identity === "stable_source" ? "GitHub repository" : "Copied text",
    purpose: identity === "stable_source" ? "Preserve source-observed repository state" : "Preserve one copy occurrence",
    schema: { name: `capture.test.${identity}`, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: createdAt, created_at: createdAt },
    representation: {
      form: "inline",
      kind: "source_record",
      media_type: "application/json",
      value: { state: 1 },
    },
    materialization: materialization(),
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test-connector",
        connection_id: "test:default",
        source_id: identity === "stable_source" ? "repo:openai/codex" : "copy:event:1",
        source_kind: identity === "stable_source" ? "repository" : "copy",
        identity,
        assertion: "direct",
      },
    },
    policy: policy(),
    ...overrides,
  });
}

test("freeform View requires the complete semantic and physical envelope", () => {
  const view = committed(derivedDraft());
  assert.equal(view.purpose, "Keep the current project summary useful for planning");
  assert.equal(view.schema.mode, "freeform");
  assert.equal(view.materialization.primary.location.kind, "inline");
  assert.deepEqual(exactViewRef(view), { view_id: view.id, revision: 1 });
  assert.equal(viewRevisionKey(exactViewRef(view)), "view:project:summary@1");
});

test("strict Schema validates the semantic Representation and fails closed", () => {
  const schema = {
    name: "project.status",
    version: 1,
    mode: "strict" as const,
    dialect: "https://json-schema.org/draft/2020-12/schema" as const,
    json_schema: {
      type: "object",
      required: ["status", "progress"],
      properties: {
        status: { type: "string" },
        progress: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
  };
  const valid = derivedDraft({
    schema,
    representation: { form: "inline", kind: "status", value: { status: "active", progress: 0.7 } },
  });
  assert.equal(valid.schema.mode, "strict");

  assert.throws(
    () => derivedDraft({
      schema,
      representation: { form: "inline", kind: "status", value: { status: "active", progress: "70%" } },
    }),
    (error: unknown) => error instanceof ViewValidationError
      && error.code === "representation_schema_mismatch"
      && error.issues.some((issue) => issue.message.includes("type")),
  );
});

test("equivalent strict Schemas share validation regardless of object order or $id", () => {
  const first = derivedDraft({
    schema: {
      name: "project.ordered",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: {
        $id: "urn:metaflow:schema:project-ordered:1",
        type: "object",
        properties: { title: { type: "string" }, count: { type: "number" } },
        required: ["title", "count"],
        additionalProperties: false,
      },
    },
    representation: { form: "inline", kind: "ordered", value: { title: "One", count: 1 } },
  });
  const second = derivedDraft({
    id: "view:project:ordered:2",
    schema: {
      name: "project.ordered",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: {
        additionalProperties: false,
        required: ["title", "count"],
        properties: { count: { type: "number" }, title: { type: "string" } },
        type: "object",
        $id: "urn:metaflow:schema:project-ordered:1",
      },
    },
    representation: { form: "inline", kind: "ordered", value: { title: "Two", count: 2 } },
  });
  assert.equal(first.schema.name, second.schema.name);
});

test("invalid strict JSON Schema is rejected before a View can exist", () => {
  assert.throws(
    () => derivedDraft({
      schema: {
        name: "invalid.schema",
        version: 1,
        mode: "strict",
        dialect: "https://json-schema.org/draft/2020-12/schema",
        json_schema: { type: "future-unknown-type" },
      },
    }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "invalid_strict_schema",
  );
});

test("external reference is a complete Representation, not its physical Materialization", () => {
  const draft = derivedDraft({
    schema: {
      name: "resource.github.repository",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: {
        type: "object",
        required: ["uri"],
        properties: { uri: { type: "string", pattern: "^https://github\\.com/" } },
        additionalProperties: false,
      },
    },
    representation: {
      form: "external_reference",
      kind: "github_repository",
      uri: "https://github.com/openai/codex",
    },
  });
  assert.deepEqual(representationSemanticValue(draft.representation), {
    uri: "https://github.com/openai/codex",
  });
  assert.equal(draft.materialization.primary.location.kind, "inline");
});

test("fetching an external reference creates a new Derived View with exact provenance", () => {
  const reference = committed(rawDraft("occurrence", {
    id: "view:raw:github-link:1",
    name: "GitHub link occurrence",
    purpose: "Preserve the external reference that the user opened",
    representation: {
      form: "external_reference",
      kind: "github_repository",
      uri: "https://github.com/openai/codex",
    },
  }));
  const fetched = derivedDraft({
    id: "view:github:openai-codex:snapshot",
    name: "Fetched repository snapshot",
    purpose: "Make the referenced repository content locally searchable",
    representation: { form: "inline", kind: "repository_snapshot", value: { readme: "Codex" } },
    provenance: { inputs: [exactViewRef(reference)], actor: "operator:github-fetch" },
    relations: [{ type: "derived_from", target: exactViewRef(reference) }],
  });
  assert.notEqual(fetched.id, reference.id);
  assert.deepEqual(fetched.provenance.inputs, [{ view_id: reference.id, revision: 1 }]);
  assert.equal(reference.representation.form, "external_reference");
});

test("persisted relations require exact target revisions", () => {
  assert.throws(
    () => derivedDraft({ relations: [{ type: "summarizes", target: { view_id: "view:raw:1" } }] }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "invalid_envelope",
  );
});

test("a graph-shaped View freezes every member at an exact revision", () => {
  const graph = derivedDraft({
    id: "view:graph:project-context",
    representation: {
      form: "inline",
      kind: "graph",
      value: { nodes: ["view:project", "view:decision"], edges: ["contains"] },
    },
    relations: [
      { type: "contains", target: { view_id: "view:project", revision: 4 } },
      { type: "contains", target: { view_id: "view:decision", revision: 2 } },
    ],
  });
  assert.deepEqual(graph.relations.map((relation) => relation.target.revision), [4, 2]);
});

test("stable Raw source state may evolve as immutable revisions of one View", () => {
  const previous = committed(rawDraft("stable_source"), 1);
  const next = rawDraft("stable_source", {
    representation: { form: "inline", kind: "source_record", value: { state: 2 } },
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.deepEqual(assertViewRevisionTransition(previous, next), {
    kind: "revision",
    base: { view_id: previous.id, revision: 1 },
  });
});

test("Raw occurrence evidence cannot be revised under the same View identity", () => {
  const previous = committed(rawDraft("occurrence"), 1);
  const next = rawDraft("occurrence", {
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.throws(
    () => assertViewRevisionTransition(previous, next),
    (error: unknown) => error instanceof ViewRevisionTransitionError && error.code === "raw_occurrence_is_immutable",
  );
});

test("same-purpose evolution revises; a new purpose requires an exact fork", () => {
  const previous = committed(derivedDraft(), 3);
  const revision = derivedDraft({
    representation: { form: "inline", kind: "markdown", value: "# Better Project" },
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.equal(assertViewRevisionTransition(previous, revision).kind, "revision");

  const changedPurpose = derivedDraft({
    purpose: "Teach English from this project",
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.throws(
    () => assertViewRevisionTransition(previous, changedPurpose),
    (error: unknown) => error instanceof ViewRevisionTransitionError && error.code === "purpose_change_requires_fork",
  );

  const fork = derivedDraft({
    id: "view:learning:project-english",
    purpose: "Teach English from this project",
    relations: [{ type: "forked_from", target: exactViewRef(previous) }],
  });
  assert.equal(assertViewRevisionTransition(previous, fork).kind, "fork");
});

test("a Schema name and version cannot be silently redefined across revisions", () => {
  const strictSchema = {
    name: "project.summary",
    version: 1,
    mode: "strict" as const,
    dialect: "https://json-schema.org/draft/2020-12/schema" as const,
    json_schema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
      additionalProperties: false,
    },
  };
  const previous = committed(derivedDraft({
    schema: strictSchema,
    representation: { form: "inline", kind: "project_summary", value: { summary: "First" } },
  }), 4);
  const redefined = derivedDraft({
    schema: {
      ...strictSchema,
      json_schema: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "number" } },
        additionalProperties: false,
      },
    },
    representation: { form: "inline", kind: "project_summary", value: { summary: 2 } },
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.throws(
    () => assertViewRevisionTransition(previous, redefined),
    (error: unknown) => error instanceof ViewRevisionTransitionError
      && error.code === "schema_revision_redefined",
  );

  const versioned = derivedDraft({
    schema: { ...redefined.schema, version: 2 },
    representation: redefined.representation,
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.equal(assertViewRevisionTransition(previous, versioned).kind, "revision");
});

test("a View cannot regress within the same Schema family", () => {
  const previous = committed(derivedDraft({
    schema: { name: "project.summary", version: 2, mode: "freeform" },
  }), 2);
  const regressed = derivedDraft({
    schema: { name: "project.summary", version: 1, mode: "freeform" },
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.throws(
    () => assertViewRevisionTransition(previous, regressed),
    (error: unknown) => error instanceof ViewRevisionTransitionError
      && error.code === "schema_version_regression",
  );
});

test("a View cannot rename its Schema family to bypass revision history", () => {
  const previous = committed(derivedDraft({
    schema: { name: "project.summary", version: 2, mode: "freeform" },
  }), 2);
  const renamed = derivedDraft({
    schema: { name: "project.summary.temporary", version: 1, mode: "freeform" },
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
  assert.throws(
    () => assertViewRevisionTransition(previous, renamed),
    (error: unknown) => error instanceof ViewRevisionTransitionError
      && error.code === "schema_family_change_requires_fork",
  );

  const fork = derivedDraft({
    id: "view:project:summary:alternative-schema",
    schema: renamed.schema,
    relations: [{ type: "forked_from", target: exactViewRef(previous) }],
  });
  assert.equal(assertViewRevisionTransition(previous, fork).kind, "fork");
});

test("Raw and Derived roles cannot impersonate each other's provenance", () => {
  assert.throws(
    () => parseViewDraft({ ...derivedDraft(), role: "raw" }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "invalid_envelope",
  );
  assert.throws(
    () => parseViewDraft({ ...rawDraft("occurrence"), role: "derived" }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "invalid_envelope",
  );
});

test("Materialization cannot smuggle semantic output into the physical manifest", () => {
  const draft = derivedDraft();
  assert.throws(
    () => parseViewDraft({
      ...draft,
      materialization: {
        primary: {
          ...draft.materialization.primary,
          value: { summary: "This belongs in a new View Representation" },
        },
      },
    }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "invalid_envelope",
  );
  assert.throws(
    () => parseViewDraft({
      ...draft,
      materialization: {
        primary: {
          ...draft.materialization.primary,
          metadata: { summary: "Semantic output cannot hide in metadata" },
        },
      },
    }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "invalid_envelope",
  );
});

test("do_not_store may guide a draft but cannot describe a committed revision", () => {
  const draft = derivedDraft({
    policy: { ...policy(), retention: "do_not_store" },
  });
  assert.equal(draft.policy.retention, "do_not_store");
  assert.throws(
    () => committed(draft),
    (error: unknown) => error instanceof ViewValidationError
      && error.code === "invalid_envelope"
      && error.issues.some((issue) => issue.path.join(".") === "policy.retention"),
  );
});

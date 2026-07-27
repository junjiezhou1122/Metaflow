import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  OperatorExecutionFailure,
} from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  MARKDOWN_FRAGMENT_SET_SCHEMA,
  MARKDOWN_PARSER_FUNCTION,
  MARKDOWN_PARSER_REF,
  executeMarkdownParser,
  parseMarkdownView,
} from "@info/markdown-parser-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import type { Transformation } from "@info/transformation";
import {
  exactViewRef,
  parseViewDraft,
  type View,
  type ViewDraft,
  type ViewPolicy,
} from "@info/view";

const now = "2026-07-27T05:00:00.000Z";
const ownerPolicy: ViewPolicy = {
  owner: "user:parser-test",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  allow_local_search: true,
  labels: ["parser-test"],
};
const accessPolicy = {
  id: "policy:parser-test",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

test("Markdown Parser produces deterministic typed fragments with exact source locations", async () => {
  const invocation = parserInvocation(`# Heading\n\nA searchable paragraph.\n\n| A | B |\n| - | - |\n| one | two |\n\n\`\`\`ts\nconst answer = 42;\n\`\`\``);
  const first = await parseMarkdownView(invocation, { timeout_ms: 1_000 });
  const replay = await parseMarkdownView(invocation, { timeout_ms: 1_000 });

  assert.deepEqual(first, replay);
  assert.deepEqual(first.fragments.map(fragment => fragment.kind), ["title", "text", "table", "code"]);
  assert.deepEqual(first.source, invocation.input.ref);
  assert.ok(first.fragments.every(fragment => fragment.location.kind === "text_range"));
  assert.ok(first.fragments.every(fragment => fragment.location.path === "/representation/value"));
  assert.ok(first.fragments.every(fragment => fragment.location.length > 0));
});

test("Markdown Parser fails explicitly for unsupported Representations and hard bounds", async () => {
  const external = parserInvocation("ignored");
  external.input.representation = {
    form: "external_reference",
    kind: "markdown",
    media_type: "text/markdown",
    uri: "https://example.test/document.md",
    metadata: {},
  };
  await assert.rejects(
    parseMarkdownView(external),
    (error: unknown) => error instanceof OperatorExecutionFailure
      && error.code === "parser_representation_unsupported",
  );

  const misleadingKind = parserInvocation("# Wrong profile");
  misleadingKind.input.representation.kind = "not-markdown-at-all";
  misleadingKind.input.representation.media_type = "application/pdf";
  await assert.rejects(
    parseMarkdownView(misleadingKind),
    (error: unknown) => error instanceof OperatorExecutionFailure
      && error.code === "parser_representation_unsupported",
  );

  const bounded = parserInvocation("# One\n\nTwo");
  bounded.limits.max_fragments = 1;
  await assert.rejects(
    parseMarkdownView(bounded, { timeout_ms: 1_000 }),
    (error: unknown) => error instanceof OperatorExecutionFailure
      && error.code === "parser_fragment_limit_exceeded",
  );

  const emptyTrailingBlock = parserInvocation("# One\n\n#");
  emptyTrailingBlock.limits.max_fragments = 1;
  assert.deepEqual(
    (await parseMarkdownView(emptyTrailingBlock, { timeout_ms: 1_000 })).fragments.map(fragment => fragment.content.text),
    ["One"],
  );
});

test("Markdown Parser crosses Function Operator, Execution atomic commit, and SQLite fragment indexing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-markdown-parser-"));
  const path = join(directory, "views.sqlite");
  const repository = new SqliteViewRepository(path);
  const functions = new FunctionOperatorAdapter([{
    reference: MARKDOWN_PARSER_FUNCTION,
    execute: executeMarkdownParser,
  }]);
  let sequence = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: () => now, id: kind => `${kind}:markdown-parser:${++sequence}` },
  );

  try {
    const source = (await repository.commit({
      draft: rawMarkdown("view:markdown:e2e", "# English learning\n\nMetaflow keeps exact provenance."),
      expected_revision: 0,
    })).view;
    const result = await runtime.execute({
      run_id: "run:markdown-parser:e2e",
      correlation_id: "correlation:markdown-parser:e2e",
      transformation: markdownTransformation(source),
      access_policy: accessPolicy,
      access_use: "local_execution",
      idempotency_key: "markdown-parser:e2e",
    });

    assert.equal(result.run.status, "succeeded");
    assert.equal(result.outputs.length, 1);
    const output = result.outputs[0]!;
    assert.equal(output.schema.name, "metaflow.view.fragment-set");
    assert.deepEqual(output.provenance.inputs, [exactViewRef(source)]);
    assert.deepEqual(output.relations, [{ type: "derived_from", target: exactViewRef(source), metadata: {} }]);
    assert.deepEqual((await repository.query({ text: "exact provenance" })).map(view => exactViewRef(view)), [exactViewRef(output)]);

    const { revision: _revision, ...outputDraft } = output;
    const invalidPointer = structuredClone(outputDraft);
    if (invalidPointer.representation.form !== "inline" || typeof invalidPointer.representation.value !== "object"
      || invalidPointer.representation.value === null || Array.isArray(invalidPointer.representation.value)) {
      throw new Error("fragment-set fixture must be an inline object");
    }
    const invalidFragments = invalidPointer.representation.value.fragments;
    if (!Array.isArray(invalidFragments) || typeof invalidFragments[0] !== "object" || invalidFragments[0] === null
      || Array.isArray(invalidFragments[0]) || typeof invalidFragments[0].location !== "object"
      || invalidFragments[0].location === null || Array.isArray(invalidFragments[0].location)) {
      throw new Error("fragment-set fixture must contain one located fragment");
    }
    invalidFragments[0].location.path = "/not~2a-pointer";
    assert.throws(() => parseViewDraft(invalidPointer));

    const mismatchedSource = structuredClone(outputDraft);
    if (mismatchedSource.representation.form !== "inline" || typeof mismatchedSource.representation.value !== "object"
      || mismatchedSource.representation.value === null || Array.isArray(mismatchedSource.representation.value)
      || !Array.isArray(mismatchedSource.representation.value.sources)) {
      throw new Error("fragment-set fixture must contain source evidence");
    }
    mismatchedSource.representation.value.sources[0] = {
      relation: "derived_from",
      view: { view_id: "view:other-source", revision: 1 },
    };
    assert.throws(() => parseViewDraft(mismatchedSource));

    const inspection = new DatabaseSync(path);
    try {
      const units = inspection.prepare(`
        select expanded_path from view_search_units_v2
        where view_id = ? and revision = ? and category = 'text'
        order by expanded_path
      `).all(output.id, output.revision) as Array<{ expanded_path: string }>;
      assert.deepEqual(units.map(unit => unit.expanded_path), [
        "/representation/value/fragments/0/content/text",
        "/representation/value/fragments/1/content/text",
      ]);
    } finally {
      inspection.close();
    }

    const replay = await runtime.execute({
      run_id: "run:markdown-parser:e2e",
      correlation_id: "correlation:markdown-parser:e2e",
      transformation: markdownTransformation(source),
      access_policy: accessPolicy,
      access_use: "local_execution",
      idempotency_key: "markdown-parser:e2e",
    });
    assert.equal(replay.run.status, "succeeded");
    assert.deepEqual(replay.outputs.map(exactViewRef), [exactViewRef(output)]);

    const independent = await runtime.execute({
      run_id: "run:markdown-parser:independent",
      correlation_id: "correlation:markdown-parser:independent",
      transformation: markdownTransformation(source),
      access_policy: accessPolicy,
      access_use: "local_execution",
    });
    assert.equal(independent.run.status, "succeeded");
    assert.equal(independent.outputs.length, 1);
    assert.notEqual(independent.outputs[0]!.id, output.id);
    assert.equal(independent.outputs[0]!.provenance.operator_run_id, independent.run.id);
    assert.deepEqual(independent.outputs[0]!.representation, output.representation);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("typed Parser failure is preserved by the Function Operator and terminal Run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-markdown-parser-failure-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter([{
    reference: MARKDOWN_PARSER_FUNCTION,
    execute: executeMarkdownParser,
  }]);
  let sequence = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: () => now, id: kind => `${kind}:markdown-parser-failure:${++sequence}` },
  );
  try {
    const source = (await repository.commit({ draft: rawMarkdown("view:markdown:too-many", "# One\n\nTwo"), expected_revision: 0 })).view;
    const transformation = markdownTransformation(source);
    transformation.operator.configuration = {
      parser: MARKDOWN_PARSER_REF,
      limits: { max_input_bytes: 1_000, max_fragments: 1, max_fragment_bytes: 1_000 },
    };
    const result = await runtime.execute({
      run_id: "run:markdown-parser:failure",
      correlation_id: "correlation:markdown-parser:failure",
      transformation,
      access_policy: accessPolicy,
      access_use: "local_execution",
    });
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "operator_failed");
    assert.equal(result.run.error?.details.operator_code, "parser_fragment_limit_exceeded");
    assert.ok(result.failure);
    assert.equal(result.outputs.length, 0);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Execution timeout and cancellation terminate the isolated Markdown Parser Worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-markdown-parser-termination-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter([{
    reference: MARKDOWN_PARSER_FUNCTION,
    execute: executeMarkdownParser,
  }]);
  let sequence = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: () => now, id: kind => `${kind}:markdown-parser-termination:${++sequence}` },
  );
  try {
    const source = (await repository.commit({
      draft: rawMarkdown("view:markdown:large", `# Large\n\n${"searchable ".repeat(50_000)}`),
      expected_revision: 0,
    })).view;
    const timedTransformation = markdownTransformation(source);
    timedTransformation.operator.configuration = {
      parser: MARKDOWN_PARSER_REF,
      limits: { max_input_bytes: 1_000_000, max_fragments: 100, max_fragment_bytes: 1_000_000 },
    };
    timedTransformation.budget = {
      id: "budget:parser.timeout",
      revision: 1,
      limits: { timeout_ms: 1 },
      extensions: {},
    };
    const timed = await runtime.execute({
      run_id: "run:markdown-parser:timeout",
      correlation_id: "correlation:markdown-parser:timeout",
      transformation: timedTransformation,
      access_policy: accessPolicy,
      access_use: "local_execution",
    });
    assert.equal(timed.run.status, "timed_out");
    assert.equal(timed.run.error?.code, "timeout");

    const cancellationTransformation = structuredClone(timedTransformation);
    cancellationTransformation.budget = {
      id: "budget:parser.cancel",
      revision: 1,
      limits: { timeout_ms: 1_000 },
      extensions: {},
    };
    const controller = new AbortController();
    const cancellation = runtime.execute({
      run_id: "run:markdown-parser:cancelled",
      correlation_id: "correlation:markdown-parser:cancelled",
      transformation: cancellationTransformation,
      access_policy: accessPolicy,
      access_use: "local_execution",
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("test cancellation")), 1);
    const cancelled = await cancellation;
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.error?.code, "cancelled");
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function parserInvocation(markdown: string) {
  return {
    contract_version: 1 as const,
    parser: MARKDOWN_PARSER_REF,
    run_id: "run:parser:unit",
    attempt_id: "attempt:parser:unit",
    input: {
      ref: { view_id: "view:markdown:source", revision: 1 },
      representation: { form: "inline" as const, kind: "markdown", media_type: "text/markdown", value: markdown, metadata: {} },
    },
    limits: { max_input_bytes: 100_000, max_fragments: 100, max_fragment_bytes: 10_000 },
  };
}

function rawMarkdown(id: string, markdown: string): ViewDraft {
  return parseViewDraft({
    id,
    name: id,
    purpose: "Raw Markdown parser fixture",
    aliases: [],
    schema: { name: "capture.test.markdown", version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: now, created_at: now },
    representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: markdown, metadata: {} },
    materialization: {
      primary: { id: "canonical-markdown", format: "markdown", media_type: "text/markdown", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test-markdown",
        connection_id: "connection:test-markdown",
        source_id: id,
        source_kind: "markdown",
        identity: "stable_source",
        assertion: "direct",
      },
    },
    policy: ownerPolicy,
    metadata: {},
  });
}

function markdownTransformation(source: View): Transformation {
  return {
    id: "transformation:parser.markdown",
    revision: 1,
    name: "Parse Markdown into search fragments",
    instruction: { format: "natural_language", text: "Project the exact Markdown View into deterministic search fragments.", parameters: {} },
    operator: {
      id: "operator:parser.markdown",
      revision: 1,
      reference: MARKDOWN_PARSER_FUNCTION,
      configuration: {
        parser: MARKDOWN_PARSER_REF,
        limits: { max_input_bytes: 100_000, max_fragments: 100, max_fragment_bytes: 10_000 },
      },
      required_capabilities: [],
    },
    inputs: [{ role: "source", required: true, sources: [{ kind: "view", ref: exactViewRef(source) }] }],
    output: { schema: MARKDOWN_FRAGMENT_SET_SCHEMA, schema_origin: "declared", cardinality: { min: 1, max: 1 } },
    policy: accessPolicy,
    budget: { id: "budget:parser.markdown", revision: 1, limits: { timeout_ms: 1_000 }, extensions: {} },
    created_at: now,
    metadata: { processor_kind: "parser", parser_id: MARKDOWN_PARSER_REF.parser_id },
  };
}

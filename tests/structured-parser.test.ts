import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  OperatorExecutionFailure,
} from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  SearchModeUnavailableError,
  SearchRequestV1Schema,
  SearchService,
  type ExactSearchScope,
  type ViewReadAuthorizationPort,
} from "@info/search";
import {
  STRUCTURED_PARSER_FUNCTIONS,
  STRUCTURED_PARSER_REFS,
  executeStructuredParser,
  parseStructuredView,
  structuredParserTransformation,
  structuredParserTransformations,
  type StructuredParserKind,
} from "@info/structured-parser-adapter";
import { exactTransformationRef, type Transformation } from "@info/transformation";
import {
  exactViewRef,
  parseViewDraft,
  type View,
  type ViewDraft,
  type ViewMaterializationManifest,
  type ViewPolicy,
  type ViewRepresentation,
} from "@info/view";
import { runViewPackageConformance } from "@info/view-package";
import {
  structuredContentFixtures,
  structuredContentSchemaKeys,
  structuredContentSchemas,
  structuredContentViewPackage,
} from "../view-packages/structured-content/index.ts";

const now = "2026-07-27T10:00:00.000Z";
const accessPolicy = {
  id: "policy:structured-parser-test",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};
const ownerPolicy: ViewPolicy = {
  owner: "user:structured-parser-test",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  allow_local_search: true,
  labels: ["structured-parser-test"],
};

test("Structured Content View Package advertises four exact Parser Transformations", () => {
  const transformations = new Map(Object.values(structuredParserTransformations).map(transformation => [
    `${transformation.id}@${transformation.revision}`,
    {
      ref: exactTransformationRef(transformation),
      output_schema: transformation.output.schema,
      input_roles: [{
        role: "source",
        required: true,
        schemas: [structuredContentSchemaKeys[parserKindForTransformation(transformation.id)]],
      }],
    },
  ]));
  const report = runViewPackageConformance({
    package: structuredContentViewPackage,
    fixtures: structuredContentFixtures,
    operations: new Set(["view.get", "view.search"]),
    renderers: new Set(),
    transformations,
  });
  assert.deepEqual(report, {
    package_id: "view-package.structured-content",
    package_version: 1,
    schemas: 4,
    fixtures: 4,
    methods: 8,
    renderers: 0,
    parsers: 4,
    processors: 0,
    evolutions: 0,
  });
  assert.deepEqual(
    structuredContentViewPackage.manifest.parsers.map(parser => `${parser.id}@${parser.version}@${parser.abi_version}`),
    ["parser.json@1@1", "parser.table@1@1", "parser.graph@1@1", "parser.external-reference@1@1"],
  );
});

test("JSON, table, graph, and external-reference Parsers preserve exact deterministic locations", async () => {
  const json = await parseStructuredView(parserInvocation("json"));
  assert.deepEqual(json.fragments.map(fragment => [fragment.location.kind, fragment.location.path, fragment.content.text]), [
    ["json_pointer", "/representation/value/a~1b", "slash"],
    ["json_pointer", "/representation/value/nested/topic", "English learning"],
    ["json_pointer", "/representation/value/tilde~0key", "tilde"],
  ]);
  assert.deepEqual(await parseStructuredView(parserInvocation("json")), json);

  const table = await parseStructuredView(parserInvocation("table"));
  assert.deepEqual(table.fragments.map(fragment => fragment.location), [
    { kind: "table_cell", path: "/representation/value/rows/0/cells/0", row: 0, column: 0, row_id: "row:1", column_id: "phrase" },
    { kind: "table_cell", path: "/representation/value/rows/0/cells/1", row: 0, column: 1, row_id: "row:1", column_id: "status" },
  ]);

  const graph = await parseStructuredView(parserInvocation("graph"));
  assert.deepEqual(graph.fragments.map(fragment => fragment.location), [
    { kind: "graph_element", path: "/representation/value/nodes/0/label", element_kind: "node", element_id: "video" },
    { kind: "graph_element", path: "/representation/value/nodes/0/properties/topic", element_kind: "node", element_id: "video", property: "/topic" },
    { kind: "graph_element", path: "/representation/value/nodes/1/label", element_kind: "node", element_id: "practice" },
    { kind: "graph_element", path: "/representation/value/edges/0/label", element_kind: "edge", element_id: "edge:1" },
    { kind: "graph_element", path: "/representation/value/edges/0/properties/weight", element_kind: "edge", element_id: "edge:1", property: "/weight" },
  ]);

  const external = await parseStructuredView(parserInvocation("external_reference"));
  assert.deepEqual(external.fragments.map(fragment => [fragment.location.path, fragment.content.text]), [
    ["/representation/uri", "https://media.example.test/english-lesson.mp4"],
    ["/representation/metadata/title", "English lesson"],
  ]);
});

test("Structured Parsers fail distinctly for unsupported, missing materialization, malformed, and bounded inputs", async () => {
  const unsupported = parserInvocation("json");
  unsupported.input.representation.kind = "property_graph";
  await rejectsWithCode(parseStructuredView(unsupported), "parser_representation_unsupported");

  const missing = parserInvocation("external_reference");
  missing.input.materialization.primary.location = { kind: "uri", uri: "https://media.example.test/different.mp4" };
  await rejectsWithCode(parseStructuredView(missing), "parser_materialization_missing");

  const malformedTable = parserInvocation("table");
  if (malformedTable.input.representation.form !== "inline") throw new Error("table fixture must be inline");
  malformedTable.input.representation.value = { columns: [{ id: "one" }], rows: [{ cells: [] }] };
  await rejectsWithCode(parseStructuredView(malformedTable), "parser_representation_malformed");

  const invalidGraph = parserInvocation("graph");
  if (invalidGraph.input.representation.form !== "inline") throw new Error("graph fixture must be inline");
  invalidGraph.input.representation.value = {
    nodes: [{ id: "one" }],
    edges: [{ id: "edge", source: "one", target: "missing" }],
  };
  await rejectsWithCode(parseStructuredView(invalidGraph), "parser_graph_invalid");

  const bounded = parserInvocation("json");
  bounded.limits.max_fragments = 1;
  await rejectsWithCode(parseStructuredView(bounded), "parser_fragment_limit_exceeded");
});

test("isolated Parser Worker keeps malformed result, crash, timeout, and cancellation observable", async () => {
  await rejectsWithCode(parseStructuredView(parserInvocation("json"), {
    worker_url: new URL("./fixtures/structured-parser-malformed-worker.mjs", import.meta.url),
  }), "parser_result_malformed");
  const overbound = parserInvocation("json");
  overbound.limits.max_fragments = 1;
  await rejectsWithCode(parseStructuredView(overbound, {
    worker_url: new URL("./fixtures/structured-parser-overbound-worker.mjs", import.meta.url),
  }), "parser_result_malformed");
  const oversizedFragment = parserInvocation("json");
  oversizedFragment.limits.max_fragment_bytes = 4;
  await rejectsWithCode(parseStructuredView(oversizedFragment, {
    worker_url: new URL("./fixtures/structured-parser-overbound-worker.mjs", import.meta.url),
  }), "parser_result_malformed");
  await rejectsWithCode(parseStructuredView(parserInvocation("json"), {
    worker_url: new URL("./fixtures/structured-parser-crash-worker.mjs", import.meta.url),
  }), "parser_implementation_crash");
  await rejectsWithCode(parseStructuredView(parserInvocation("json"), {
    worker_url: new URL("./fixtures/structured-parser-hang-worker.mjs", import.meta.url),
    timeout_ms: 10,
  }), "parser_timeout");

  const controller = new AbortController();
  const reason = new Error("explicit parser cancellation");
  const cancelled = parseStructuredView(parserInvocation("json"), {
    worker_url: new URL("./fixtures/structured-parser-hang-worker.mjs", import.meta.url),
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
});

test("all four Parser Functions cross Execution and atomically commit untrusted fragment candidates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-structured-parser-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter(
    (Object.keys(STRUCTURED_PARSER_FUNCTIONS) as StructuredParserKind[]).map(kind => ({
      reference: STRUCTURED_PARSER_FUNCTIONS[kind],
      execute: executeStructuredParser,
    })),
  );
  let sequence = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: () => now, id: kind => `${kind}:structured-parser:${++sequence}` },
  );

  try {
    const sources = new Map<StructuredParserKind, View>();
    const outputs = new Map<StructuredParserKind, View>();
    for (const kind of Object.keys(STRUCTURED_PARSER_REFS) as StructuredParserKind[]) {
      const source = (await repository.commit({ draft: sourceDraft(kind), expected_revision: 0 })).view;
      sources.set(kind, source);
      const result = await runtime.execute({
        run_id: `run:structured-parser:${kind}`,
        correlation_id: `correlation:structured-parser:${kind}`,
        transformation: structuredParserTransformation(kind),
        invocation_inputs: [{ role: "source", views: [exactViewRef(source)] }],
        access_policy: accessPolicy,
        access_use: "local_execution",
      });
      assert.equal(result.run.status, "succeeded");
      assert.equal(result.outputs.length, 1);
      const output = result.outputs[0]!;
      assert.equal(output.schema.name, "metaflow.view.fragment-set");
      assert.equal(output.schema.version, 2);
      assert.deepEqual(output.provenance.inputs, [exactViewRef(source)]);
      assert.deepEqual(output.relations, [{ type: "derived_from", target: exactViewRef(source), metadata: {} }]);
      assert.equal(output.metadata.parser_id, STRUCTURED_PARSER_REFS[kind].parser_id);
      outputs.set(kind, output);
    }
    assert.equal((await repository.query({ schema_name: "metaflow.view.fragment-set", revisions: "all", limit: 10 })).length, 4);

    const search = searchService(repository);
    const one = await search.search({
      request_id: "search:structured:one",
      principal: { id: ownerPolicy.owner },
      request: keywordRequest("English", { kind: "exact_views", refs: [exactViewRef(outputs.get("json")!)] }),
    });
    assert.deepEqual(one.hits.map(hit => hit.ref), [exactViewRef(outputs.get("json")!)]);
    assert.deepEqual(one.hits[0]?.matches.map(match => match.location), [{
      kind: "representation",
      path: "/representation/value/fragments/1/content/text",
      coordinates: { kind: "json_pointer", path: "/representation/value/nested/topic" },
    }]);

    const selected = await search.search({
      request_id: "search:structured:selected",
      principal: { id: ownerPolicy.owner },
      request: keywordRequest("learning", {
        kind: "exact_views",
        refs: [exactViewRef(outputs.get("json")!), exactViewRef(outputs.get("table")!)],
      }),
    });
    assert.deepEqual(new Set(selected.hits.map(hit => hit.ref.view_id)), new Set([
      outputs.get("json")!.id,
      outputs.get("table")!.id,
    ]));
    const tableMatch = selected.hits.find(hit => hit.ref.view_id === outputs.get("table")!.id)?.matches[0];
    assert.deepEqual(tableMatch?.location, {
      kind: "representation",
      path: "/representation/value/fragments/1/content/text",
      coordinates: {
        kind: "table_cell",
        path: "/representation/value/rows/0/cells/1",
        row: 0,
        column: 1,
        row_id: "row:1",
        column_id: "status",
      },
    });

    const graph = await search.search({
      request_id: "search:structured:graph-coordinate",
      principal: { id: ownerPolicy.owner },
      request: keywordRequest("English", { kind: "exact_views", refs: [exactViewRef(outputs.get("graph")!)] }),
    });
    assert.deepEqual(graph.hits[0]?.matches[0]?.location, {
      kind: "representation",
      path: "/representation/value/fragments/1/content/text",
      coordinates: {
        kind: "graph_element",
        path: "/representation/value/nodes/0/properties/topic",
        element_kind: "node",
        element_id: "video",
        property: "/topic",
      },
    });

    const external = await search.search({
      request_id: "search:structured:external-coordinate",
      principal: { id: ownerPolicy.owner },
      request: keywordRequest("media", { kind: "exact_views", refs: [exactViewRef(outputs.get("external_reference")!)] }),
    });
    assert.deepEqual(external.hits[0]?.matches[0]?.location, {
      kind: "representation",
      path: "/representation/value/fragments/0/content/text",
      coordinates: { kind: "external_reference", path: "/representation/uri" },
    });

    const subgraph = await search.search({
      request_id: "search:structured:subgraph",
      principal: { id: ownerPolicy.owner },
      request: keywordRequest("English", {
        kind: "subgraph",
        roots: [exactViewRef(sources.get("json")!)],
        direction: "incoming",
        relation_types: ["derived_from"],
        max_depth: 1,
        max_nodes: 2,
      }),
    });
    assert.deepEqual(subgraph.hits.map(hit => hit.ref), [exactViewRef(outputs.get("json")!)]);

    await assert.rejects(
      search.search({
        request_id: "search:structured:missing-capability",
        principal: { id: ownerPolicy.owner },
        request: keywordRequest("English", { kind: "exact_views", refs: [exactViewRef(sources.get("json")!)] }),
      }),
      (error: unknown) => error instanceof SearchModeUnavailableError && error.code === "parser_capability_missing",
    );
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Execution records structured Parser timeout and cancellation as distinct terminal Runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-structured-parser-termination-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter([{
    reference: STRUCTURED_PARSER_FUNCTIONS.json,
    execute: executeStructuredParser,
  }]);
  let sequence = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: () => now, id: kind => `${kind}:structured-parser-termination:${++sequence}` },
  );
  try {
    const source = (await repository.commit({ draft: sourceDraft("json"), expected_revision: 0 })).view;
    const timedTransformation = structuredParserTransformation("json");
    timedTransformation.budget = {
      id: "budget:parser.json.timeout",
      revision: 1,
      limits: { timeout_ms: 1, max_attempts: 1 },
      extensions: {},
    };
    const timed = await runtime.execute({
      run_id: "run:structured-parser:timeout",
      correlation_id: "correlation:structured-parser:timeout",
      transformation: timedTransformation,
      invocation_inputs: [{ role: "source", views: [exactViewRef(source)] }],
      access_policy: accessPolicy,
      access_use: "local_execution",
    });
    assert.equal(timed.run.status, "timed_out");
    assert.equal(timed.run.error?.code, "timeout");

    const cancellationTransformation = structuredParserTransformation("json");
    const controller = new AbortController();
    const cancellation = runtime.execute({
      run_id: "run:structured-parser:cancelled",
      correlation_id: "correlation:structured-parser:cancelled",
      transformation: cancellationTransformation,
      invocation_inputs: [{ role: "source", views: [exactViewRef(source)] }],
      access_policy: accessPolicy,
      access_use: "local_execution",
    }, { signal: controller.signal });
    controller.abort(new Error("explicit Execution cancellation"));
    const cancelled = await cancellation;
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.error?.code, "cancelled");
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function parserInvocation(kind: StructuredParserKind) {
  const draft = sourceDraft(kind);
  return {
    contract_version: 2 as const,
    parser: STRUCTURED_PARSER_REFS[kind],
    run_id: `run:parser:${kind}`,
    attempt_id: `attempt:parser:${kind}`,
    input: {
      ref: { view_id: draft.id, revision: 1 },
      representation: draft.representation,
      materialization: draft.materialization,
    },
    limits: { max_input_bytes: 100_000, max_fragments: 100, max_fragment_bytes: 10_000 },
  };
}

function sourceDraft(kind: StructuredParserKind): ViewDraft {
  const representation = representations[kind]();
  const materialization: ViewMaterializationManifest = representation.form === "external_reference"
    ? {
        primary: {
          id: "source-uri",
          format: "external-reference",
          media_type: representation.media_type ?? "application/octet-stream",
          location: { kind: "uri", uri: representation.uri },
        },
        alternatives: [],
      }
    : {
        primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
        alternatives: [],
      };
  return parseViewDraft({
    id: `view:structured:${kind}`,
    name: `Structured ${kind} fixture`,
    purpose: "Verify heterogeneous Parser Workers",
    aliases: [],
    schema: structuredContentSchemas[kind],
    role: "raw",
    time: { observed_at: now, created_at: now },
    representation,
    materialization,
    relations: [],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test-structured",
        connection_id: "connection:test-structured",
        source_id: `source:${kind}`,
        source_kind: kind,
        identity: "stable_source",
        assertion: "direct",
      },
    },
    policy: ownerPolicy,
    metadata: {},
  });
}

const representations: Record<StructuredParserKind, () => ViewRepresentation> = {
  json: () => ({
    form: "inline",
    kind: "json_document",
    media_type: "application/json",
    value: { "a/b": "slash", nested: { topic: "English learning" }, "tilde~key": "tilde" },
    metadata: {},
  }),
  table: () => ({
    form: "inline",
    kind: "data_table",
    media_type: "application/json",
    value: {
      columns: [{ id: "phrase", label: "Phrase" }, { id: "status", label: "Status" }],
      rows: [{ id: "row:1", cells: ["spaced repetition", "learning"] }],
    },
    metadata: {},
  }),
  graph: () => ({
    form: "inline",
    kind: "property_graph",
    media_type: "application/json",
    value: {
      nodes: [
        { id: "video", label: "YouTube lesson", properties: { topic: "English" } },
        { id: "practice", label: "Speaking practice" },
      ],
      edges: [{ id: "edge:1", source: "video", target: "practice", label: "creates", properties: { weight: 2 } }],
    },
    metadata: {},
  }),
  external_reference: () => ({
    form: "external_reference",
    kind: "external_resource",
    media_type: "video/mp4",
    uri: "https://media.example.test/english-lesson.mp4",
    metadata: { title: "English lesson" },
  }),
};

function parserKindForTransformation(id: string): StructuredParserKind {
  const entry = (Object.entries(structuredParserTransformations) as Array<[StructuredParserKind, Transformation]>).find(
    ([, transformation]) => transformation.id === id,
  );
  if (!entry) throw new Error(`Unknown Parser Transformation ${id}`);
  return entry[0];
}

function searchService(repository: SqliteViewRepository): SearchService {
  const authorization: ViewReadAuthorizationPort = {
    authorize: async input => Promise.all(input.refs.map(async ref => {
      const view = await repository.get(ref);
      return {
        ref,
        status: !view ? "missing" as const : view.policy.owner === input.principal.id ? "allowed" as const : "denied" as const,
        ...(!view || view.policy.owner === input.principal.id ? {} : { code: "owner_mismatch" }),
      };
    })),
  };
  return new SearchService({
    authorization,
    scope_source: repository.search,
    descriptors: repository.search,
    keyword: repository.search,
    observer: { record: async () => {} },
    now: () => now,
  });
}

function keywordRequest(text: string, scope: ExactSearchScope) {
  return SearchRequestV1Schema.parse({
    contract_version: 1,
    query: { text },
    scope,
    target: { envelope: false, internal: true, related_views: false },
    modes: ["keyword"],
    fusion: { strategy: "rrf@1", k: 60, weights: {} },
    failure_mode: "require_all",
    page: { limit: 100 },
  });
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof OperatorExecutionFailure && error.code === code,
  );
}

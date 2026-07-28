import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CaptureIngress,
  ConnectorPackageCatalog,
  ConnectorRuntime,
  SourceConnectionOnboardingService,
  TrustedConnectorPackageLoader,
  type ConnectorPort,
} from "@info/capture";
import { AuthoringService, lifecycleValue } from "@info/authoring";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  FeedbackEvolutionService,
  type OperatorExecutionPort,
  type OperatorExecutionResult,
} from "@info/execution";
import {
  GrantOperationAuthorizer,
  OPERATION_CATALOG,
  OPERATION_NAMES,
  OperationEnvelopeSchema,
  OperationService,
  RepositoryViewReadAuthorizer,
  ViewQueryRegistry,
  type OperationContext,
  type OperationEnvelope,
  type OperationName,
  type OperationObserver,
  type OperationTraceEvent,
  type ViewQueryMethod,
} from "@info/operations";
import { SearchService } from "@info/search";
import { PrivacyForgetService, canonicalJson, exactViewRef, parseViewDraft } from "@info/view";
import {
  CliOperationAdapter,
  HttpOperationAdapter,
  OperationMcpOutputJsonSchema,
  METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  createOperationMcpServer,
  operationMcpToolName,
} from "@info/operation-surfaces";
import {
  SqliteVecEmbeddingViewSchema,
  SqliteViewRepository,
  sqliteVecSourceDigest,
} from "@info/storage-sqlite";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";
import { exactTransformationRef } from "@info/transformation";
import { ViewPackageCatalog } from "@info/view-package";

type Surface = {
  name: "in-process" | "cli" | "http" | "mcp";
  call(operation: OperationName, input: unknown): Promise<OperationEnvelope>;
  close(): Promise<void>;
};

const policy = {
  owner: "user:local",
  visibility: "private" as const,
  privacy: "private" as const,
  retention: "normal" as const,
  allow_external_model: false,
  allow_embedding: true,
  labels: ["operation-conformance"],
};

test("catalog schemas cover every Operation while examples remain limited to bounded Agent access", () => {
  const validator = new AjvJsonSchemaValidator();
  assert.equal(OPERATION_CATALOG.length, OPERATION_NAMES.length);
  assert.ok(OPERATION_CATALOG.every(entry => entry.input_schema.type === "object"));
  for (const entry of OPERATION_CATALOG) {
    const validate = validator.getValidator(entry.input_schema as any);
    if (entry.input_example !== undefined) assert.equal(validate(entry.input_example).valid, true, entry.name);
  }
  assert.deepEqual(
    OPERATION_CATALOG.filter(entry => entry.input_example !== undefined).map(entry => entry.name),
    ["catalog.list", "view.get", "view.graph.project", "view.search"],
  );
  assert.equal(
    `sha256:${createHash("sha256").update(canonicalJson(OPERATION_CATALOG)).digest("hex")}`,
    METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  );
});

test("official MCP client rejects structured content outside the advertised discriminated envelope", async () => {
  const server = new Server({ name: "invalid-output-fixture", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "invalid_envelope",
      inputSchema: { type: "object" },
      outputSchema: OperationMcpOutputJsonSchema as any,
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text" as const, text: "invalid" }],
    structuredContent: { ok: true, request_id: "request:missing-data", operation: "catalog.list" },
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "output-schema-regression", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const schema = listed.tools[0]!.outputSchema as { type: string; oneOf?: unknown[] };
    assert.equal(schema.type, "object");
    assert.equal(schema.oneOf?.length, 2);
    const failure = schema.oneOf?.[1] as { required?: string[] };
    assert.deepEqual(failure.required, ["ok", "request_id", "operation", "error"]);
    await assert.rejects(
      client.callTool({ name: "invalid_envelope", arguments: {} }),
      /Structured content does not match the tool's output schema/u,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("in-process, CLI, HTTP, and real MCP return the same structured success and failure", async () => {
  await withHarness(async harness => {
    const captured = await harness.service.execute(captureRequest("shared"), context("request:seed"));
    assert.equal(captured.ok, true);
    const ref = captureRef(captured);
    const surfaces = await createSurfaces(harness, () => context("request:equivalent"));
    const forbiddenGraphSurfaces = await createSurfaces(
      harness,
      () => context("request:graph-forbidden", ["view.get"]),
    );
    try {
      const successes = await Promise.all(surfaces.map(surface => surface.call("view.get", { ref })));
      for (const success of successes.slice(1)) assert.deepEqual(success, successes[0]);

      const projections = await Promise.all(surfaces.map(surface => surface.call("view.graph.project", {
        request: graphRequest(ref),
      })));
      for (const projection of projections.slice(1)) assert.deepEqual(projection, projections[0]);
      assert.deepEqual((projections[0] as Extract<OperationEnvelope, { ok: true }>).data, {
        projection_version: 1,
        roots: [ref],
        nodes: [{
          ref,
          name: "Captured operation page",
          purpose: "Exercise the shared v1 operation surfaces",
          schema: { name: "capture.operation.page", version: 1 },
          role: "raw",
          time: { observed_at: "2026-07-26T14:00:00.000Z", created_at: "2026-07-26T14:00:01.000Z" },
          representation: { kind: "browser_page", media_type: "application/json" },
          depth: 0,
          path: [],
        }],
        edges: [],
        frontier: [{ ref, reason: "depth_limit" }],
        truncation: { truncated: true, reasons: ["depth_limit"] },
        redacted_boundary: false,
      });
      const forbiddenProjections = await Promise.all(forbiddenGraphSurfaces.map(surface => surface.call("view.graph.project", {
        request: graphRequest(ref),
      })));
      for (const failure of forbiddenProjections.slice(1)) assert.deepEqual(failure, forbiddenProjections[0]);
      assert.equal(forbiddenProjections[0]?.ok, false);
      if (!forbiddenProjections[0]?.ok) assert.equal(forbiddenProjections[0]?.error.code, "operation_forbidden");

      const missing = { view_id: "view:missing:equivalent", revision: 1 };
      const failures = await Promise.all(surfaces.map(surface => surface.call("view.get", { ref: missing })));
      for (const failure of failures.slice(1)) assert.deepEqual(failure, failures[0]);
      assert.deepEqual(failures[0], {
        ok: false,
        request_id: "request:equivalent",
        operation: "view.get",
        error: {
          code: "view_not_found",
          message: "Exact View revision does not exist",
          category: "not_found",
          details: { ref: missing },
        },
      });

      const mcp = surfaces.find(surface => surface.name === "mcp") as Surface & { toolNames?: string[] };
      assert.equal(mcp.toolNames?.length, OPERATION_NAMES.length);
      assert.deepEqual(new Set(mcp.toolNames), new Set(OPERATION_NAMES.map(operationMcpToolName)));
    } finally {
      await Promise.all([...surfaces, ...forbiddenGraphSurfaces].map(surface => surface.close()));
    }
  });
});

test("natural-language View authoring has one exact lifecycle across in-process, CLI, HTTP, and official MCP", async () => {
  await withHarness(async harness => {
    const surfaces = await createSurfaces(harness, () => context("request:authoring-equivalent"));
    try {
      const requested = await callEquivalent(surfaces, "view.authoring.request", authoringRequest());
      const requestRef = exactViewRef(requested.data as any);
      const proposed = await callEquivalent(surfaces, "view.authoring.propose", authoringPropose(requestRef));
      const proposal = proposed.data as any;
      const proposalValue = lifecycleValue(proposal) as any;
      const stale = await surfaces[0]!.call("view.authoring.approve", authoringDecision(exactViewRef(proposal), "0".repeat(64)));
      assert.equal(stale.ok, false);
      if (!stale.ok) assert.equal(stale.error.code, "authoring_digest_mismatch");
      const approved = await callEquivalent(surfaces, "view.authoring.approve", authoringDecision(exactViewRef(proposal), proposalValue.artifact_digest));
      const receipt = await callEquivalent(surfaces, "view.authoring.apply", authoringApply(exactViewRef(approved.data as any)));
      assert.equal((lifecycleValue(receipt.data as any) as any).status, "applied");
      const inspected = await callEquivalent(surfaces, "view.authoring.inspect", { ref: exactViewRef(receipt.data as any) });
      assert.deepEqual((inspected.data as any).view, receipt.data);
      const mcp = surfaces.find(surface => surface.name === "mcp") as Surface & { toolNames?: string[] };
      assert.equal(mcp.toolNames?.includes(operationMcpToolName("view.authoring.apply")), true);
    } finally {
      await Promise.all(surfaces.map(surface => surface.close()));
    }
  });
});

test("Feedback evolution has one exact lifecycle across in-process, CLI, HTTP, and official MCP", async () => {
  await withHarness(async harness => {
    const captured = await harness.service.execute(captureRequest("feedback-parity"), context("request:feedback-seed"));
    const source = captureRef(captured);
    const transformation = transformationFor(source);
    const committed = await harness.transformations.commit({
      transformation,
      expected_revision: 0,
      idempotency_key: "transformation:feedback-parity",
    });
    const execution = await harness.service.execute({
      operation: "run.execute",
      input: runRequest(transformation.id, source, "run:feedback-parity"),
    }, context("request:feedback-run"));
    assert.equal(execution.ok, true);
    const output = (execution as Extract<OperationEnvelope, { ok: true }>).data as any;
    const recorded = await harness.service.execute({
      operation: "feedback.submit",
      input: {
        feedback: {
          feedback_id: "feedback:operation-parity",
          sentiment: "correction",
          message: "Focus the summary on decisions and contradictions.",
          actor: "user:local",
          occurred_at: "2026-07-26T14:10:00.000Z",
          target_view: exactViewRef(output.outputs[0]),
          target_run_id: "run:feedback-parity",
          requested_changes: ["instruction"],
          metadata: {},
        },
      },
    }, context("request:feedback-record"));
    assert.equal(recorded.ok, true);
    const feedbackRef = exactViewRef(((recorded as Extract<OperationEnvelope, { ok: true }>).data as any).view);
    const surfaces = await createSurfaces(harness, () => context("request:feedback-apply-equivalent"));
    try {
      const evolved = await callEquivalent(surfaces, "feedback.apply", {
        feedback: feedbackRef,
        base_transformation: exactTransformationRef(committed.transformation),
        change: {
          instruction: {
            ...transformation.instruction,
            text: "Summarize the exact captured page, emphasizing decisions and contradictions.",
          },
        },
        actor: "user:local",
        resolution: "Applied the requested focus explicitly.",
        created_at: "2026-07-26T14:11:00.000Z",
      });
      assert.equal((evolved.data as any).revision, 2);
      assert.deepEqual((evolved.data as any).supersedes, exactTransformationRef(committed.transformation));
      assert.equal(
        (surfaces.find(surface => surface.name === "mcp") as Surface & { toolNames?: string[] }).toolNames
          ?.includes(operationMcpToolName("feedback.apply")),
        true,
      );
      const missing = await surfaces[0]!.call("feedback.apply", {
        feedback: { view_id: "view:feedback:missing", revision: 1 },
        base_transformation: exactTransformationRef(committed.transformation),
        change: {
          instruction: {
            ...transformation.instruction,
            text: "This request must fail before Transformation evolution.",
          },
        },
        actor: "user:local",
        resolution: "Missing evidence cannot be applied.",
        created_at: "2026-07-26T14:12:00.000Z",
      });
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.error.code, "view_not_found");

      const denied = await harness.service.execute({
        operation: "feedback.apply",
        input: {
          feedback: feedbackRef,
          base_transformation: { transformation_id: transformation.id, revision: 2 },
          change: {
            instruction: {
              ...transformation.instruction,
              text: "A different principal must not inspect or apply this feedback.",
            },
          },
          actor: "user:other",
          resolution: "This request must be denied before reading Feedback evidence.",
          created_at: "2026-07-26T14:13:00.000Z",
        },
      }, {
        request_id: "request:feedback-apply-denied",
        principal: { id: "user:other", grants: ["feedback.apply"] },
      });
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.error.code, "view_read_forbidden");
    } finally {
      await Promise.all(surfaces.map(surface => surface.close()));
    }
  });
});

test("Connector catalog and Source Connection lifecycle Operations have CLI, HTTP, and MCP parity", async () => {
  await withHarness(async harness => {
    const surfaces = await createSurfaces(harness, () => context("request:connector-parity"));
    const otherOwnerSurfaces = await createSurfaces(harness, () => ({
      request_id: "request:connector-other-owner",
      principal: { id: "user:other", grants: ["*"] },
    }));
    try {
      for (const [operation, input] of [
        ["connector.list", {}],
        ["capture.connection.list", {}],
        ["connector.inspect", { package: { id: "missing", version: "1.0.0", digest: "a".repeat(64) } }],
      ] as const) {
        const responses = await Promise.all(surfaces.map(surface => surface.call(operation, input)));
        for (const response of responses.slice(1)) assert.deepEqual(response, responses[0], operation);
      }
      for (const [operation, input] of [
        ["capture.connection.create", {
          idempotency_key: "connector-parity:create",
          package: { id: "missing", version: "1.0.0", digest: "a".repeat(64) },
          connection: {
            id: "connection:missing",
            display_name: "Missing package",
            delivery_kinds: ["pull"],
            secret_refs: {},
            configuration: {},
          },
        }],
        ["capture.connection.check", lifecycleMissingInput("check")],
        ["capture.connection.discover", lifecycleMissingInput("discover")],
        ["capture.connection.activate", lifecycleMissingInput("activate")],
        ["capture.connection.update", lifecycleMissingInput("update")],
        ["capture.connection.pause", lifecycleMissingInput("pause")],
        ["capture.connection.run", { ...lifecycleMissingInput("run"), delivery: "pull", parameters: {} }],
        ["capture.dlq.list", { connection_id: "connection:missing", status: "pending" }],
        ["capture.dlq.replay", { id: "dead-letter:missing" }],
      ] as const) {
        const responses = await Promise.all(surfaces.map(surface => surface.call(operation, input)));
        assert.equal(responses[0]?.ok, false, operation);
        for (const response of responses.slice(1)) assert.deepEqual(response, responses[0], operation);
      }
      const connections = await surfaces[0]!.call("capture.connection.list", {});
      assert.equal(connections.ok, true);
      if (connections.ok) {
        const lifecycle = (connections.data as Array<{ generation: number; status: string }>)[0];
        assert.deepEqual(lifecycle, {
          connection: {
            id: "connection:operations",
            connector_id: "connector:operation-manual",
            connector_version: "1.0.0",
            display_name: "Operation conformance manual source",
            enabled: true,
            delivery_kinds: ["manual_import"],
            secret_refs: {},
            configuration: {},
            privacy: policy,
          },
          generation: 1,
          status: "active",
          created_at: lifecycle?.created_at,
          updated_at: lifecycle?.updated_at,
        });
      }
      const hiddenConnections = await Promise.all(otherOwnerSurfaces.map(surface => surface.call("capture.connection.list", {})));
      for (const response of hiddenConnections) {
        assert.equal(response.ok, true);
        if (response.ok) assert.deepEqual(response.data, []);
      }
      const deniedTraces = await Promise.all(otherOwnerSurfaces.map(surface => surface.call("trace.read", {
        scope: "capture",
        connection_id: "connection:operations",
      })));
      for (const response of deniedTraces) {
        assert.equal(response.ok, false);
        if (!response.ok) assert.equal(response.error.code, "connection_owner_mismatch");
      }
    } finally {
      await Promise.all([...surfaces, ...otherOwnerSurfaces].map(surface => surface.close()));
    }
  });
});

test("view.resolve.latest and typed view.query stay equivalent across every operation surface", async () => {
  await withHarness(async harness => {
    const captured = await harness.service.execute(captureRequest("query-shared"), context("request:query-seed"));
    assert.equal(captured.ok, true);
    const ref = captureRef(captured);
    const surfaces = await createSurfaces(harness, () => context("request:query-equivalent"));
    try {
      const latest = await Promise.all(surfaces.map(surface => surface.call("view.resolve.latest", { view_id: ref.view_id })));
      for (const result of latest.slice(1)) assert.deepEqual(result, latest[0]);
      assert.deepEqual((latest[0] as Extract<OperationEnvelope, { ok: true }>).data, ref);

      const input = {
        request: {
          contract_version: 1,
          subject: ref,
          profile: { id: "operation.page.entries", version: 1 },
          parameters: { section: "content", include_metadata: true },
          page: { limit: 10 },
        },
      };
      const queried = await Promise.all(surfaces.map(surface => surface.call("view.query", input)));
      for (const result of queried.slice(1)) assert.deepEqual(result, queried[0]);
      const data = (queried[0] as Extract<OperationEnvelope, { ok: true }>).data as any;
      assert.deepEqual(data.subject, ref);
      assert.deepEqual(data.items, [{
        key: `entry:${ref.view_id}:${ref.revision}`,
        evidence: [ref],
        value: { parameters: input.request.parameters },
      }]);

      const unknown = await surfaces[0]!.call("view.query", {
        request: { ...input.request, profile: { id: "operation.page.unknown", version: 1 } },
      });
      assert.equal(unknown.ok, false);
      if (!unknown.ok) assert.equal(unknown.error.code, "view_query_profile_unknown");
    } finally {
      await Promise.all(surfaces.map(item => item.close()));
    }
  });
});

test("in-process, CLI, HTTP, and real MCP return identical sqlite-vec semantic evidence", async () => {
  await withHarness(async harness => {
    const captured = await harness.service.execute(captureRequest("semantic-shared"), context("request:semantic-seed"));
    const sourceRef = captureRef(captured);
    const source = await harness.views.get(sourceRef);
    assert.ok(source);
    const text = (source.representation.form === "inline" && typeof source.representation.value === "object"
      && source.representation.value !== null && !Array.isArray(source.representation.value))
      ? source.representation.value.text
      : undefined;
    assert.equal(typeof text, "string");
    const embedding = (await harness.views.commit({
      draft: parseViewDraft({
        id: "view:operation-semantic-embedding",
        name: "Operation surface semantic embedding",
        purpose: "Prove the same exact semantic evidence crosses every operation surface",
        schema: SqliteVecEmbeddingViewSchema,
        role: "derived",
        time: { created_at: "2026-07-26T14:00:03.000Z" },
        representation: {
          form: "inline",
          kind: "metaflow.search.embedding",
          media_type: "application/json",
          value: {
            contract_version: 1,
            target: {
              ref: sourceRef,
              location: { kind: "representation", path: "/representation/value/text" },
              source_digest: sqliteVecSourceDigest(text),
            },
            profile: {
              id: "embedding:operation-fixture",
              revision: 1,
              provider: "fixture",
              model: "operation-3d",
              dimension: 3,
              distance_metric: "cosine",
            },
            vector: [1, 0, 0],
          },
        },
        materialization: {
          primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
        },
        relations: [{ type: "embedding_of", target: sourceRef }],
        provenance: {
          inputs: [sourceRef],
          operator_run_id: "run:operation-semantic-embedding",
          actor: "fixture:operation-embedder",
        },
        policy,
      }),
      expected_revision: 0,
    })).view;
    const surfaces = await createSurfaces(harness, () => context("request:semantic-equivalent"));
    try {
      const responses = await Promise.all(surfaces.map(surface => surface.call("view.search", {
        request: semanticSearchRequest(sourceRef, exactViewRef(embedding)),
      })));
      for (const response of responses.slice(1)) assert.deepEqual(response, responses[0]);
      const response = responses[0];
      assert.equal(response.ok, true);
      if (response.ok) {
        const hits = (response.data as { hits: Array<{ ref: unknown; matches: Array<{ semantic_evidence_ref?: unknown }> }> }).hits;
        assert.deepEqual(hits.map(hit => hit.ref), [sourceRef]);
        assert.deepEqual(hits[0]!.matches[0]!.semantic_evidence_ref, exactViewRef(embedding));
      }
      const missing = await harness.service.execute({
        operation: "view.get",
        input: { ref: { view_id: "view:semantic:missing", revision: 1 } },
      }, context("request:semantic:missing"));
      assert.equal(missing.ok, false);
    } finally {
      await Promise.all(surfaces.map(surface => surface.close()));
    }
  });
});

test("operation grants cannot bypass exact private View read authorization", async () => {
  await withHarness(async harness => {
    const committed = await harness.views.commit({
      draft: parseViewDraft({
        id: "view:private:other-owner",
        name: "Other owner's private English notes",
        purpose: "Prove operation grants do not grant content access",
        schema: {
          name: "private.notes",
          version: 1,
          mode: "freeform",
          search_projection: { version: 1, fields: [{ path: "/name", category: "title" }] },
        },
        role: "derived",
        time: { created_at: "2026-07-26T14:00:04.000Z" },
        representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: "private" },
        materialization: {
          primary: { id: "canonical", format: "markdown", media_type: "text/markdown", location: { kind: "inline" } },
        },
        provenance: { inputs: [], actor: "user:other" },
        policy: {
          owner: "user:other",
          visibility: "private",
          privacy: "private",
          retention: "normal",
          allow_external_model: false,
          allow_embedding: false,
          labels: [],
        },
      }),
      expected_revision: 0,
    });
    const ref = exactViewRef(committed.view);
    for (const [operation, input] of [
      ["view.get", { ref }],
      ["view.search", { request: searchRequest(ref, "English") }],
      ["view.traverse", { query: { ref, direction: "both", limit: 10 } }],
    ] as const) {
      const result = await harness.service.execute({ operation, input }, context(`request:private:${operation}`));
      assert.equal(result.ok, false, operation);
      if (!result.ok) {
        assert.equal(result.error.code, "view_read_forbidden", operation);
        assert.equal(result.error.category, "forbidden", operation);
      }
    }
    const projection = await harness.service.execute({
      operation: "view.graph.project",
      input: { request: graphRequest(ref) },
    }, context("request:private:view.graph.project"));
    assert.equal(projection.ok, true);
    if (projection.ok) {
      assert.deepEqual((projection.data as any).nodes, []);
      assert.equal((projection.data as any).redacted_boundary, true);
    }
  });
});

for (const surfaceName of ["in-process", "cli", "http", "mcp"] as const) {
  test(`${surfaceName} completes the full v1 operation catalog scenario`, async () => {
    await withHarness(async harness => {
      const surfaces = await createSurfaces(harness, input => context(`request:${surfaceName}:${input.operation ?? "invalid"}`));
      const surface = surfaces.find(item => item.name === surfaceName)!;
      try {
        const catalog = await ok(surface.call("catalog.list", {}));
        assert.deepEqual(new Set((catalog.data as Array<{ name: string }>).map(item => item.name)), new Set(OPERATION_NAMES));

        const captured = await ok(surface.call("capture.ingest", captureRequest(surfaceName).input));
        const source = captureRef(captured);

        const exact = await ok(surface.call("view.get", { ref: source }));
        assert.equal((exact.data as any).schema.name, "capture.operation.page");
        const projected = await ok(surface.call("view.graph.project", { request: graphRequest(source) }));
        assert.deepEqual((projected.data as any).nodes.map((node: any) => node.ref), [source]);
        const searched = await ok(surface.call("view.search", {
          request: searchRequest(source, "Operation"),
        }));
        assert.equal((searched.data as { hits: unknown[] }).hits.length, 1);
        const reindexed = await ok(surface.call("view.search.reindex", {
          run_id: `reindex:${surfaceName}`,
          requested_at: "2026-07-26T14:00:05.000Z",
        }));
        assert.equal((reindexed.data as { status: string }).status, "succeeded");
        const traversed = await ok(surface.call("view.traverse", { query: { ref: source, direction: "both", limit: 10 } }));
        assert.deepEqual(traversed.data, []);

        const transformation = transformationFor(source);
        const submitted = await ok(surface.call("transformation.submit", {
          transformation,
          expected_revision: 0,
          idempotency_key: `transformation:${surfaceName}`,
        }));
        assert.equal((submitted.data as any).transformation.id, transformation.id);
        const loaded = await ok(surface.call("transformation.get", {
          ref: { transformation_id: transformation.id, revision: 1 },
        }));
        assert.equal((loaded.data as any).name, transformation.name);

        const execution = await ok(surface.call("run.execute", runRequest(transformation.id, source, `run:${surfaceName}:success`)));
        const output = (execution.data as any).outputs[0];
        assert.equal(output.schema.name, "summary.operation.page");
        const run = await ok(surface.call("run.inspect", { run_id: `run:${surfaceName}:success` }));
        assert.equal((run.data as any).run.status, "succeeded");
        const decision = await ok(surface.call("policy.decision.get", { run_id: `run:${surfaceName}:success` }));
        assert.equal((decision.data as any).outcome, "allowed");
        const runTrace = await ok(surface.call("trace.read", { scope: "run", run_id: `run:${surfaceName}:success` }));
        assert.equal((runTrace.data as any[]).at(-1)?.type, "run.succeeded");
        const captureTrace = await ok(surface.call("trace.read", { scope: "capture", connection_id: "connection:operations" }));
        assert.ok((captureTrace.data as any[]).some(event => event.type === "capture.batch_committed"));

        const feedback = await ok(surface.call("feedback.submit", {
          feedback: {
            feedback_id: `feedback:${surfaceName}`,
            sentiment: "positive",
            message: "This summary matches the captured page.",
            actor: "user:local",
            occurred_at: "2026-07-26T14:10:00.000Z",
            target_view: exactViewRef(output),
            target_run_id: `run:${surfaceName}:success`,
            requested_changes: [],
            metadata: {},
          },
        }));
        assert.equal((feedback.data as any).view.schema.name, "metaflow.feedback");

        const failed = await ok(surface.call("run.execute", runRequest(transformation.id, source, `run:${surfaceName}:failure`)));
        assert.equal((failed.data as any).run.status, "failed");
        const failure = await ok(surface.call("failure.inspect", { ref: exactViewRef((failed.data as any).failure) }));
        assert.equal((failure.data as any).view.schema.name, "metaflow.execution.failure");
        assert.equal((failure.data as any).evidence.error.code, "candidate_invalid");

        const pending = surface.call("run.execute", runRequest(transformation.id, source, `run:${surfaceName}:cancel`));
        await waitForRun(harness.views, `run:${surfaceName}:cancel`);
        const cancellation = await ok(surface.call("run.cancel", { run_id: `run:${surfaceName}:cancel` }));
        assert.equal((cancellation.data as any).status, "cancellation_requested");
        const cancelled = await ok(pending);
        assert.equal((cancelled.data as any).run.status, "cancelled");

        const deniedContext = context(`request:${surfaceName}:denied`, []);
        const denied = await harness.service.execute({ operation: "policy.decision.get", input: { run_id: `run:${surfaceName}:success` } }, deniedContext);
        assert.equal(denied.ok, false);
        if (!denied.ok) assert.equal(denied.error.code, "operation_forbidden");

        const tombstone = await ok(surface.call("view.tombstone", {
          source,
          reason: "deleted_upstream",
          occurred_at: "2026-07-26T14:20:00.000Z",
          idempotency_key: `tombstone:${surfaceName}`,
        }));
        assert.equal((tombstone.data as any).view.representation.kind, "metaflow.source_tombstone");

        const preview = await ok(surface.call("privacy.forget.request", {
          request_id: `forget:${surfaceName}`,
          requested_at: "2026-07-26T14:21:00.000Z",
          targets: [{ kind: "exact_view", ref: source }],
          mixed_source_rule: "purge",
        }));
        assert.equal((preview.data as any).status, "previewed");
        const forgotten = await ok(surface.call("privacy.forget.execute", {
          request_id: `forget:${surfaceName}`,
          authorization: {
            kind: "confirmed_preview",
            plan_digest: (preview.data as any).plan.plan_digest,
          },
        }));
        assert.equal((forgotten.data as any).status, "succeeded");
        const audit = await ok(surface.call("privacy.forget.inspect", { request_id: `forget:${surfaceName}` }));
        assert.equal((audit.data as any).receipts.at(-1)?.store_id, "view-store");
        const purged = await surface.call("view.get", { ref: source });
        assert.equal(purged.ok, false);
        if (!purged.ok) assert.equal(purged.error.code, "view_not_found");
      } finally {
        await Promise.all(surfaces.map(item => item.close()));
      }
    });
  });
}

function lifecycleMissingInput(action: string) {
  return {
    connection_id: "connection:missing",
    expected_generation: 1,
    idempotency_key: `connector-parity:${action}`,
  };
}

async function createSurfaces(
  harness: Harness,
  contextProvider: (input: { transport: "cli" | "http" | "mcp"; operation?: string }) => OperationContext,
): Promise<Array<Surface & { toolNames?: string[] }>> {
  const cli = new CliOperationAdapter(harness.service, contextProvider);
  const http = new HttpOperationAdapter(harness.service, contextProvider);
  const server = createOperationMcpServer({ service: harness.service, context: contextProvider });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metaflow-operation-conformance", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();

  return [
    {
      name: "in-process",
      call: async (operation, input) => harness.service.execute({ operation, input }, contextProvider({ transport: "cli", operation })),
      close: async () => undefined,
    },
    {
      name: "cli",
      call: async (operation, input) => (await cli.invoke([operation, JSON.stringify(input)])).envelope,
      close: async () => undefined,
    },
    {
      name: "http",
      call: async (operation, input) => (await http.handle({
        method: "POST",
        path: `/metaflow/v1/operations/${encodeURIComponent(operation)}`,
        body: input,
      })).body,
      close: async () => undefined,
    },
    {
      name: "mcp",
      toolNames: tools.tools.map(tool => tool.name),
      call: async (operation, input) => {
        const result = await client.callTool({ name: operationMcpToolName(operation), arguments: input as Record<string, unknown> });
        return OperationEnvelopeSchema.parse(result.structuredContent);
      },
      close: async () => {
        await client.close();
        await server.close();
      },
    },
  ];
}

type Harness = {
  directory: string;
  views: SqliteViewRepository;
  transformations: SqliteTransformationRepository;
  service: OperationService;
  observer: MemoryObserver;
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-operation-surfaces-"));
  const database = join(directory, "metaflow.sqlite");
  const views = new SqliteViewRepository(database, {
    semantic_search: {
      profiles: [{
        id: "embedding:operation-fixture",
        revision: 1,
        provider: "fixture",
        model: "operation-3d",
        dimension: 3,
        distance_metric: "cosine",
      }],
    },
  });
  const transformations = new SqliteTransformationRepository(database);
  const clock = deterministicClock();
  const capture = new ConnectorRuntime(views, new CaptureIngress({ repository: views, now: clock }), { now: clock });
  const connector = manualConnector();
  capture.registerConnector(connector);
  await capture.registerConnection({
    id: "connection:operations",
    connector_id: connector.manifest.id,
    connector_version: connector.manifest.version,
    display_name: "Operation conformance manual source",
    enabled: true,
    delivery_kinds: ["manual_import"],
    secret_refs: {},
    configuration: {},
    privacy: policy,
  });
  const operator = new ConformanceOperator();
  let executionId = 0;
  const execution = new ExecutionRuntime(
    views,
    views,
    new DeterministicViewAccessAuthorizer(),
    operator,
    undefined,
    { now: clock, id: kind => `${kind}:operation-conformance:${++executionId}` },
  );
  const feedback = new FeedbackEvolutionService({ views, runs: views, transformations });
  const privacy = new PrivacyForgetService({ views, requests: views, now: clock });
  const observer = new MemoryObserver();
  const viewReads = new RepositoryViewReadAuthorizer(views);
  const search = new SearchService({
    authorization: viewReads,
    scope_source: views.search,
    descriptors: views.search,
    keyword: views.search,
    semantic: views.semantic_search,
    query_embedding: {
      async embed() {
        return { values: [1, 0, 0], dimension: 3, distance_metric: "cosine" };
      },
    },
    observer: { async record() {} },
    now: clock,
  });
  const authoring = new AuthoringService({
    views,
    transformations,
    execution,
    packages: new ViewPackageCatalog(),
    agent: {
      async propose() {
        return operationAuthoringViewCandidate();
      },
    },
    observer: { async record() {} },
    now: clock,
  });
  const connectorCatalog = new ConnectorPackageCatalog();
  const service = new OperationService({
    views,
    graph: views.search,
    search,
    view_reads: viewReads,
    view_queries: new ViewQueryRegistry([new OperationPageQueryMethod()]),
    transformations,
    execution,
    runs: views,
    feedback,
    privacy,
    capture,
    connector_onboarding: new SourceConnectionOnboardingService({
      catalog: connectorCatalog,
      loader: new TrustedConnectorPackageLoader({
        catalog: connectorCatalog,
        artifacts: {
          async inspect() { return undefined; },
          async instantiate() { throw new Error("No Connector Packages are installed"); },
        },
        publisher_keys: { async publicKey() { return undefined; } },
        allowed_permissions: [],
        supported_abi_version: 1,
      }),
      runtime: capture,
      repository: views,
      now: clock,
    }),
    capture_traces: views,
    authoring,
    authorization: new GrantOperationAuthorizer(),
    observer,
    now: clock,
  });
  try {
    await run({ directory, views, transformations, service, observer });
    assert.equal(observer.events.filter(event => event.type === "operation.started").length > 0, true);
    assert.equal(observer.events.some(event => event.type === "operation.failed"), true);
  } finally {
    transformations.close();
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function callEquivalent(surfaces: Surface[], operation: OperationName, input: unknown) {
  const responses = await Promise.all(surfaces.map(surface => surface.call(operation, input)));
  for (const response of responses.slice(1)) assert.deepEqual(response, responses[0]);
  assert.equal(responses[0]?.ok, true, responses[0]?.ok ? undefined : JSON.stringify(responses[0]?.error));
  return responses[0] as Extract<OperationEnvelope, { ok: true }>;
}

function authoringRequest() {
  return {
    view_id: "view:operation:authoring:request",
    expected_revision: 0,
    artifact_kind: "view",
    prompt: "Create an English learning View from my saved material",
    source_views: [],
    policy,
    trace_id: "trace:operation:authoring",
    idempotency_key: "operation:authoring:request",
    created_at: "2026-07-26T14:10:00.000Z",
  };
}

function authoringPropose(request: { view_id: string; revision: number }) {
  return {
    request,
    proposal_view_id: "view:operation:authoring:proposal",
    expected_revision: 0,
    idempotency_key: "operation:authoring:proposal",
    failure_receipt_view_id: "view:operation:authoring:proposal-failure",
    created_at: "2026-07-26T14:10:01.000Z",
  };
}

function authoringDecision(proposal: { view_id: string; revision: number }, proposalDigest: string) {
  return {
    proposal,
    proposal_digest: proposalDigest,
    decision_view_id: "view:operation:authoring:decision",
    expected_revision: 0,
    idempotency_key: "operation:authoring:decision",
    created_at: "2026-07-26T14:10:02.000Z",
  };
}

function authoringApply(decision: { view_id: string; revision: number }) {
  return {
    decision,
    receipt_view_id: "view:operation:authoring:receipt",
    expected_revision: 0,
    idempotency_key: "operation:authoring:apply",
    created_at: "2026-07-26T14:10:03.000Z",
  };
}

function operationAuthoringViewCandidate() {
  return {
    kind: "view",
    view: {
      id: "view:operation:authored:learning",
      name: "Authored English learning View",
      purpose: "Prove one authoring lifecycle across every shared surface",
      aliases: [],
      schema: { name: "learning.operation.authored", version: 1, mode: "freeform" },
      representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: "# Learning", metadata: {} },
      materialization: {
        primary: { id: "canonical", format: "markdown", media_type: "text/markdown", location: { kind: "inline" } },
        alternatives: [],
      },
      relations: [],
      metadata: {},
      expected_revision: 0,
    },
  };
}

class OperationPageQueryMethod implements ViewQueryMethod {
  readonly profile = { id: "operation.page.entries", version: 1 } as const;
  readonly subject_schema = { name: "capture.operation.page", version: 1 } as const;
  readonly parameters = {
    dialect: "https://json-schema.org/draft/2020-12/schema" as const,
    json_schema: true,
    pagination: { kind: "cursor" as const, max_page_size: 100 },
  };

  async query(input: Parameters<ViewQueryMethod["query"]>[0]) {
    const ref = exactViewRef(input.subject);
    return {
      items: [{
        key: `entry:${ref.view_id}:${ref.revision}`,
        evidence: [ref],
        value: { parameters: input.parameters },
      }],
      redacted_boundary: false,
    };
  }
}

function searchRequest(ref: { view_id: string; revision: number }, text: string) {
  return {
    contract_version: 1 as const,
    query: { text },
    scope: { kind: "exact_views" as const, refs: [ref] },
    target: { envelope: true, internal: true, related_views: false },
    modes: ["keyword" as const],
    fusion: { strategy: "rrf@1" as const, k: 60 as const, weights: { keyword: 1 } },
    failure_mode: "require_all" as const,
    page: { limit: 10 },
  };
}

function graphRequest(ref: { view_id: string; revision: number }) {
  return {
    roots: [ref],
    direction: "both" as const,
    edge_types: ["derived_from"],
    max_depth: 0,
    max_nodes: 10,
    max_edges: 10,
  };
}

function semanticSearchRequest(
  target: { view_id: string; revision: number },
  evidence: { view_id: string; revision: number },
) {
  return {
    contract_version: 1 as const,
    query: { text: "operation semantic fixture" },
    scope: { kind: "exact_views" as const, refs: [target, evidence] },
    target: { envelope: false, internal: true, related_views: false },
    modes: ["semantic" as const],
    semantic: { embedding_profile: { id: "embedding:operation-fixture", revision: 1 } },
    fusion: { strategy: "rrf@1" as const, k: 60 as const, weights: { semantic: 1 } },
    failure_mode: "require_all" as const,
    page: { limit: 10 },
  };
}

class MemoryObserver implements OperationObserver {
  readonly events: OperationTraceEvent[] = [];
  readonly causes: unknown[] = [];

  async record(event: OperationTraceEvent, cause?: unknown): Promise<void> {
    this.events.push(event);
    if (cause !== undefined) this.causes.push(cause);
  }
}

class ConformanceOperator implements OperatorExecutionPort {
  async execute(invocation: Parameters<OperatorExecutionPort["execute"]>[0], context: Parameters<OperatorExecutionPort["execute"]>[1]): Promise<OperatorExecutionResult> {
    if (invocation.run.id.endsWith(":cancel")) {
      return new Promise(resolve => {
        context.signal.addEventListener("abort", () => resolve({ status: "cancelled", reason: "cancelled by operation" }), { once: true });
      });
    }
    if (invocation.run.id.endsWith(":failure")) {
      return { status: "succeeded", candidate: { malformed: true } };
    }
    const inputViews = invocation.inputs.flatMap(binding => binding.views);
    return {
      status: "succeeded",
      candidate: {
        outputs: [{
          expected_revision: 0,
          idempotency_key: `output:${invocation.run.id}`,
          draft: {
            id: `view:summary:${invocation.run.id}`,
            name: "Operation surface summary",
            purpose: "Prove one Transformation produces the same View through every surface",
            aliases: [],
            schema: invocation.run.frozen.transformation.output.schema,
            role: "derived",
            time: { created_at: "2026-07-26T14:05:00.000Z" },
            representation: {
              form: "inline",
              kind: "operation_summary",
              media_type: "application/json",
              value: { summary: "A captured page passed through the shared operation service." },
              metadata: {},
            },
            materialization: {
              primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
              alternatives: [],
            },
            relations: inputViews.map(view => ({ type: "derived_from", target: exactViewRef(view), metadata: {} })),
            provenance: {
              inputs: inputViews.map(exactViewRef),
              operator_run_id: invocation.run.id,
              actor: "operator:operation-conformance",
              trace_id: invocation.run.trace_id,
            },
            policy: inputViews[0]!.policy,
            metadata: {},
          },
        }],
        diagnostics: { adapter: "operation-conformance" },
      },
    };
  }

  async cancel(): Promise<void> {}
}

function manualConnector(): ConnectorPort {
  return {
    manifest: {
      id: "connector:operation-manual",
      version: "1.0.0",
      display_name: "Operation conformance connector",
      protocols: ["filesystem"],
      capabilities: ["manual_import"],
      delivery_kinds: ["manual_import"],
      emitted_schemas: [{
        name: "capture.operation.page",
        version: 1,
        mode: "freeform",
        search_projection: {
          version: 1,
          fields: [
            { path: "/name", category: "title" },
            { path: "/representation/value/text", category: "text" },
          ],
        },
      }],
    },
    async health() { return { capabilities: ["manual_import"] }; },
    async *open() { throw new Error("Manual-import connector must not be opened"); },
  };
}

function captureRequest(id: string) {
  return {
    operation: "capture.ingest" as const,
    input: {
      batch: {
        id: `batch:${id}`,
        idempotency_key: `batch:${id}`,
        connector: { id: "connector:operation-manual", version: "1.0.0" },
        connection_id: "connection:operations",
        delivery: "manual_import",
        sequence: 1,
        candidates: [{
          idempotency_key: `candidate:${id}`,
          name: "Captured operation page",
          purpose: "Exercise the shared v1 operation surfaces",
          aliases: ["https://example.com/operations"],
          schema: {
            name: "capture.operation.page",
            version: 1,
            mode: "freeform",
            search_projection: {
              version: 1,
              fields: [
                { path: "/name", category: "title" },
                { path: "/representation/value/text", category: "text" },
              ],
            },
          },
          observed_at: "2026-07-26T14:00:00.000Z",
          captured_at: "2026-07-26T14:00:01.000Z",
          source: {
            connector: "connector:operation-manual",
            connection_id: "connection:operations",
            source_id: `page:${id}`,
            source_kind: "page",
            identity: "occurrence",
            assertion: "direct",
          },
          representation: {
            form: "inline",
            kind: "browser_page",
            media_type: "application/json",
            value: { url: "https://example.com/operations", title: "Operation surfaces", text: "One exact captured page." },
            metadata: {},
          },
          policy,
          relations: [],
          metadata: {},
        }],
        created_at: "2026-07-26T14:00:02.000Z",
        metadata: {},
      },
    },
  };
}

function transformationFor(source: { view_id: string; revision: number }) {
  return {
    id: "transformation:operation-summary",
    revision: 1,
    name: "Summarize one operation page",
    instruction: {
      format: "natural_language",
      text: "Summarize the exact captured page.",
      language: "en",
      parameters: {},
    },
    operator: {
      id: "operator:operation-summary",
      revision: 1,
      reference: { kind: "function", function_id: "operation-summary", version: 1 },
      configuration: {},
      required_capabilities: [],
    },
    inputs: [{ role: "page", required: true, sources: [{ kind: "view", ref: source }] }],
    output: {
      schema: { name: "summary.operation.page", version: 1, mode: "freeform" },
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    policy: {
      id: "policy:operation-summary",
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    budget: {
      id: "budget:operation-summary",
      revision: 1,
      limits: { timeout_ms: 10_000, max_attempts: 1, max_cost_usd: 1 },
      extensions: {},
    },
    created_at: "2026-07-26T14:01:00.000Z",
    metadata: {},
  };
}

function runRequest(transformationId: string, source: { view_id: string; revision: number }, runId: string) {
  return {
    transformation: { transformation_id: transformationId, revision: 1 },
    parameters: {
      run_id: runId,
      correlation_id: `correlation:${runId}`,
      access_policy: {
        id: "policy:operation-summary",
        revision: 1,
        configuration: { kind: "view_access", profile: "approve_all", rules: [] },
      },
      access_use: "local_execution",
      invocation_inputs: [{ role: "page", views: [source] }],
      idempotency_key: `execution:${runId}`,
    },
  };
}

function captureRef(envelope: OperationEnvelope): { view_id: string; revision: number } {
  assert.equal(envelope.ok, true);
  const receipt = (envelope.data as any).receipts[0];
  assert.equal(receipt.status, "stored");
  return { view_id: receipt.view_id, revision: receipt.revision };
}

async function ok(promise: Promise<OperationEnvelope>): Promise<Extract<OperationEnvelope, { ok: true }>> {
  const envelope = await promise;
  assert.equal(envelope.ok, true, envelope.ok ? undefined : JSON.stringify(envelope.error));
  return envelope as Extract<OperationEnvelope, { ok: true }>;
}

function context(requestId: string, grants: Array<OperationName | "*"> = ["*"]): OperationContext {
  return { request_id: requestId, principal: { id: "user:local", grants } };
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T14:00:10.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

async function waitForRun(repository: SqliteViewRepository, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await repository.getRun(runId)) return;
    await nextTurn();
  }
  throw new Error(`Run ${runId} was not persisted before cancellation`);
}

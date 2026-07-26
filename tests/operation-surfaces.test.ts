import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CaptureIngress,
  ConnectorRuntime,
  type ConnectorPort,
} from "@info/capture";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  FeedbackEvolutionService,
  type OperatorExecutionPort,
  type OperatorExecutionResult,
} from "@info/execution";
import {
  GrantOperationAuthorizer,
  OPERATION_NAMES,
  OperationEnvelopeSchema,
  OperationService,
  RepositoryViewReadAuthorizer,
  type OperationContext,
  type OperationEnvelope,
  type OperationName,
  type OperationObserver,
  type OperationTraceEvent,
} from "@info/operations";
import { SearchService } from "@info/search";
import { PrivacyForgetService, exactViewRef, parseViewDraft } from "@info/view";
import {
  CliOperationAdapter,
  HttpOperationAdapter,
  createOperationMcpServer,
  operationMcpToolName,
} from "@info/operation-surfaces";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";

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
  allow_embedding: false,
  labels: ["operation-conformance"],
};

test("in-process, CLI, HTTP, and real MCP return the same structured success and failure", async () => {
  await withHarness(async harness => {
    const captured = await harness.service.execute(captureRequest("shared"), context("request:seed"));
    assert.equal(captured.ok, true);
    const ref = captureRef(captured);
    const surfaces = await createSurfaces(harness, () => context("request:equivalent"));
    try {
      const successes = await Promise.all(surfaces.map(surface => surface.call("view.get", { ref })));
      for (const success of successes.slice(1)) assert.deepEqual(success, successes[0]);

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
  const views = new SqliteViewRepository(database);
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
    secret_refs: [],
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
    observer: { async record() {} },
    now: clock,
  });
  const service = new OperationService({
    views,
    search,
    view_reads: viewReads,
    transformations,
    execution,
    runs: views,
    feedback,
    privacy,
    capture,
    capture_traces: views,
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

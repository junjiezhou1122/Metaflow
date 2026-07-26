import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  CaptureIngress,
  ConnectorKitError,
  ConnectorRuntime,
  defineConnectorKit,
  runConnectorConformance,
  secretReference,
  type CommitCaptureBatchResult,
} from "@info/capture";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  CLIPBOARD_CONNECTOR_KIT,
  ClipboardConnectionConfigurationSchema,
  clipboardSourceConnection,
  configureClipboardCapture,
  type ClipboardSourcePayload,
} from "../packages/adapters/clipboard-capture/index.ts";

const capturedAt = "2026-07-26T05:00:00.000Z";

function policy() {
  return {
    owner: "user:test",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: ["capture"],
  };
}

const VersionedPayloadSchema = z.object({
  event_id: z.string().min(1),
  schema_version: z.union([z.literal(1), z.literal(2)]),
  value: z.string(),
}).strict();

const VERSIONED_KIT = defineConnectorKit({
  manifest: {
    id: "test-versioned-source",
    version: "1.0.0",
    display_name: "Versioned source fixture",
    protocols: ["webhook"],
    capabilities: ["versioned_payload"],
    delivery_kinds: ["push"],
    emitted_schemas: [
      { name: "capture.test.versioned", version: 1, mode: "freeform" },
      { name: "capture.test.versioned", version: 2, mode: "freeform" },
    ],
  },
  configuration_schema: z.object({ source: z.string().min(1) }).strict(),
  payload_schema: VersionedPayloadSchema,
  adapt(payload, context) {
    return [{
      idempotency_key: `versioned:${payload.event_id}`,
      name: `Versioned ${payload.event_id}`,
      purpose: "Exercise Connector Kit Schema evolution",
      schema: { name: "capture.test.versioned", version: payload.schema_version, mode: "freeform" },
      source: context.stableSource({ source_id: payload.event_id, source_kind: "versioned_fixture" }),
      representation: { form: "inline", kind: "source_payload", value: payload, metadata: {} },
      metadata: { configured_source: context.configuration.source },
    }];
  },
});

test("Connector conformance covers declared Schema evolution and stable identity", async () => {
  const connection = VERSIONED_KIT.createConnection({
    id: "versioned:test",
    display_name: "Versioned test",
    configuration: { source: "fixture" },
    privacy: policy(),
  });
  const cases = [1, 2].map(schemaVersion => ({
    name: `schema-v${schemaVersion}`,
    payload: { event_id: `event-${schemaVersion}`, schema_version: schemaVersion as 1 | 2, value: `value-${schemaVersion}` },
    captured_at: capturedAt,
    expected_candidate_count: 1,
    expected_schemas: [`capture.test.versioned@${schemaVersion}`],
    assert_lossless({ payload, candidates }: { payload: z.infer<typeof VersionedPayloadSchema>; candidates: ReturnType<typeof VERSIONED_KIT.adapt> }) {
      assert.deepEqual(candidates[0]?.representation.form === "inline" ? candidates[0].representation.value : undefined, payload);
      assert.equal(candidates[0]?.source.identity, "stable_source");
    },
  }));
  const report = await runConnectorConformance({
    kit: VERSIONED_KIT,
    connection,
    cases,
    malformed_payloads: [{ event_id: "missing-version", value: "x" }],
    async submit({ payload, captured_at }) {
      return VERSIONED_KIT.adapt({ connection, payload, captured_at });
    },
    replay_identity(candidates) {
      return candidates.map(candidate => ({
        idempotency_key: candidate.idempotency_key,
        source: candidate.source,
        schema: candidate.schema,
      }));
    },
  });
  assert.deepEqual(report.cases.map(item => item.schemas[0]), [
    "capture.test.versioned@1",
    "capture.test.versioned@2",
  ]);
  assert.equal(report.malformed_payloads_rejected, 1);
});

test("Connector Kit rejects undeclared Schemas, weakened policy, secrets, and wrong connections", () => {
  const undeclared = defineConnectorKit({
    manifest: {
      id: "strict-source",
      version: "1.0.0",
      display_name: "Strict source",
      protocols: ["webhook"],
      capabilities: [],
      delivery_kinds: ["push"],
      emitted_schemas: [{ name: "capture.strict", version: 1, mode: "freeform" }],
    },
    configuration_schema: z.object({}).strict(),
    payload_schema: z.object({}).strict(),
    adapt(payload, context) {
      return [{
        idempotency_key: "strict:1",
        name: "Strict fixture",
        purpose: "Reject undeclared Schema",
        schema: { name: "capture.strict", version: 2, mode: "freeform" },
        source: context.occurrence({ source_id: "strict:1", source_kind: "strict_fixture" }),
        representation: { form: "inline", kind: "fixture", value: payload, metadata: {} },
      }];
    },
  });
  const connection = undeclared.createConnection({
    id: "strict:connection",
    display_name: "Strict connection",
    configuration: {},
    privacy: policy(),
  });
  assert.throws(
    () => undeclared.adapt({ connection, payload: {}, captured_at: capturedAt }),
    (error: unknown) => error instanceof ConnectorKitError && error.code === "candidate_schema_not_declared",
  );

  const policyKit = defineConnectorKit({
    manifest: {
      id: "policy-source",
      version: "1.0.0",
      display_name: "Policy source",
      protocols: ["webhook"],
      capabilities: [],
      delivery_kinds: ["push"],
      emitted_schemas: [{ name: "capture.policy", version: 1, mode: "freeform" }],
    },
    configuration_schema: z.object({}).strict(),
    payload_schema: z.object({}).strict(),
    adapt(_payload, context) {
      return [{
        idempotency_key: "policy:1",
        name: "Policy fixture",
        purpose: "Reject weaker candidate policy",
        schema: { name: "capture.policy", version: 1, mode: "freeform" },
        source: context.occurrence({ source_id: "policy:1", source_kind: "policy_fixture" }),
        representation: { form: "inline", kind: "fixture", value: {}, metadata: {} },
        policy: { ...context.connection.privacy, visibility: "public", allow_external_model: true },
      }];
    },
  });
  const policyConnection = policyKit.createConnection({
    id: "policy:connection",
    display_name: "Policy connection",
    configuration: {},
    privacy: policy(),
  });
  assert.throws(
    () => policyKit.adapt({ connection: policyConnection, payload: {}, captured_at: capturedAt }),
    (error: unknown) => error instanceof ConnectorKitError && error.code === "candidate_policy_weakened",
  );

  assert.deepEqual(secretReference({ provider: "keychain", key: "clipboard.api-key" }), {
    provider: "keychain",
    key: "clipboard.api-key",
  });
  assert.throws(
    () => CLIPBOARD_CONNECTOR_KIT.createConnection({
      id: "clipboard:secret",
      display_name: "Invalid secret",
      configuration: { device_id: "mac", api_key: "inline-secret" },
      privacy: policy(),
    }),
    (error: unknown) => error instanceof ConnectorKitError && error.code === "invalid_connection_configuration",
  );
  assert.throws(
    () => VERSIONED_KIT.adapt({
      connection: clipboardSourceConnection({ privacy: policy() }),
      payload: { event_id: "wrong", schema_version: 1, value: "x" },
      captured_at: capturedAt,
    }),
    (error: unknown) => error instanceof ConnectorKitError && error.code === "connection_connector_mismatch",
  );
});

test("Clipboard Connector passes conformance through ordinary Capture Runtime and SQLite", async () => {
  const repository = new SqliteViewRepository(":memory:");
  try {
    const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository }));
    const connection = clipboardSourceConnection({ privacy: policy(), device_id: "mac:test" });
    const controller = await configureClipboardCapture({ runtime, connection });
    const textPayload: ClipboardSourcePayload = {
      event_id: "clipboard:text:1",
      change_count: 41,
      occurred_at: "2026-07-26T05:00:00.000Z",
      captured_at: "2026-07-26T05:00:00.050Z",
      source_app: "Obsidian",
      formats: ["public.utf8-plain-text"],
      content: { text: "View Algebra notes", file_urls: [] },
    };
    const filePayload: ClipboardSourcePayload = {
      event_id: "clipboard:files:1",
      change_count: 42,
      occurred_at: "2026-07-26T05:01:00.000Z",
      captured_at: "2026-07-26T05:01:00.050Z",
      source_app: "Finder",
      formats: ["public.file-url"],
      content: {
        file_urls: [
          "file:///Users/junjie/Documents/source.pdf",
          "file:///Users/junjie/Documents/slides.key",
        ],
      },
    };
    const report = await runConnectorConformance<z.infer<typeof ClipboardConnectionConfigurationSchema>, ClipboardSourcePayload, CommitCaptureBatchResult>({
      kit: CLIPBOARD_CONNECTOR_KIT,
      connection,
      cases: [
        {
          name: "lossless-text",
          payload: textPayload,
          captured_at: textPayload.captured_at,
          expected_candidate_count: 1,
          expected_schemas: ["capture.clipboard.event@1"],
          assert_lossless({ payload, candidates }) {
            const representation = candidates[0]?.representation;
            assert.equal(representation?.form, "inline");
            if (representation?.form === "inline") assert.deepEqual(representation.value, payload);
            assert.equal(candidates[0]?.source.identity, "occurrence");
            assert.deepEqual(candidates[0]?.policy, connection.privacy);
          },
        },
        {
          name: "multiple-file-references",
          payload: filePayload,
          captured_at: filePayload.captured_at,
          expected_candidate_count: 3,
          expected_schemas: [
            "capture.clipboard.event@1",
            "capture.clipboard.file_reference@1",
            "capture.clipboard.file_reference@1",
          ],
          assert_lossless({ payload, candidates }) {
            const root = candidates[0]?.representation;
            assert.equal(root?.form, "inline");
            if (root?.form === "inline") assert.deepEqual(root.value, payload);
            assert.deepEqual(
              candidates.slice(1).map(candidate => candidate.representation.form === "external_reference" ? candidate.representation.uri : undefined),
              payload.content.file_urls ?? [],
            );
          },
        },
      ],
      malformed_payloads: [
        { event_id: "missing-content", change_count: 43, occurred_at: capturedAt, captured_at: capturedAt, content: {} },
        { event_id: "unknown-field", change_count: 44, occurred_at: capturedAt, captured_at: capturedAt, content: { text: "x" }, token: "must-fail" },
      ],
      submit: ({ payload }) => controller.submit(payload),
      replay_identity(result) {
        return result.receipts.map(receipt => receipt.status === "stored"
          ? { status: receipt.status, view_id: receipt.view_id, revision: receipt.revision }
          : { status: receipt.status, idempotency_key: receipt.idempotency_key });
      },
    });
    assert.deepEqual(report.cases.map(item => item.candidate_count), [1, 3]);
    assert.equal(report.malformed_payloads_rejected, 2);

    const views = await repository.query({ role: "raw", revisions: "all", limit: 20 });
    assert.equal(views.length, 4, "exact replay must not duplicate admitted Raw Views");
    assert.equal(views.every(view => view.provenance.capture?.connector === "macos-clipboard"), true);
    assert.equal(views.filter(view => view.schema.name === "capture.clipboard.file_reference").length, 2);
    assert.deepEqual((await repository.query({ text: "View Algebra notes" })).map(view => view.schema.name), [
      "capture.clipboard.event",
    ]);
    assert.deepEqual((await repository.query({ text: "Documents source pdf" })).map(view => view.schema.name).sort(), [
      "capture.clipboard.event",
      "capture.clipboard.file_reference",
    ]);
    assert.equal((await repository.getCaptureCheckpoint(connection.id))?.revision, 2);
  } finally {
    repository.close();
  }
});

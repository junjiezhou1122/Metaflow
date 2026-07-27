import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  CaptureIngress,
  CaptureRuntimeError,
  ConnectorRuntime,
  runConnectorConformance,
  type CaptureBatch,
  type CaptureRuntimeRepository,
} from "@info/capture";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  CODEX_HISTORY_CONNECTOR_KIT,
  CODEX_ROLLOUT_PARSER_CONTRACT,
  CodexHistoryCaptureConnector,
  SecretlintRecommendedContentGate,
  codexHistorySourceConnection,
  configureCodexHistoryCapture,
  type CodexContentGate,
  type CodexHistorySourcePayload,
} from "../packages/adapters/codex-history-capture/index.ts";

const fixtureDirectory = join(import.meta.dirname, "fixtures", "codex-history");
const fixedTimestamp = "2026-07-27T06:00:00.000Z";

function privatePolicy() {
  return {
    owner: "user:test",
    visibility: "private" as const,
    privacy: "sensitive" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: false,
    labels: ["codex-history"],
  };
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-27T06:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

async function syntheticHome(fixtureName: string): Promise<{
  root: string;
  active: string;
  archived: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "metaflow-codex-history-"));
  const activeDirectory = join(root, "sessions", "2026", "07", "27");
  const archiveDirectory = join(root, "archived_sessions");
  await mkdir(activeDirectory, { recursive: true });
  await mkdir(archiveDirectory, { recursive: true });
  const active = join(activeDirectory, "rollout-synthetic.jsonl");
  const archived = join(archiveDirectory, "rollout-synthetic.jsonl");
  await copyFile(join(fixtureDirectory, fixtureName), active);
  return { root, active, archived, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function setup(input: {
  root: string;
  repository?: SqliteViewRepository;
  runtime_repository?: CaptureRuntimeRepository;
  source_root?: "sessions" | "archived_sessions" | "both";
  content_gate?: CodexContentGate;
}) {
  const repository = input.repository ?? new SqliteViewRepository(":memory:");
  const runtimeRepository = input.runtime_repository ?? repository;
  const runtime = new ConnectorRuntime(runtimeRepository, new CaptureIngress({ repository: runtimeRepository }), {
    now: deterministicClock(),
  });
  const connector = new CodexHistoryCaptureConnector({
    codex_home: input.root,
    now: deterministicClock(),
    ...(input.content_gate ? { content_gate: input.content_gate } : {}),
  });
  const connection = codexHistorySourceConnection({
    id: "codex-history:test",
    source_root: input.source_root ?? "both",
    privacy: privatePolicy(),
  });
  await configureCodexHistoryCapture({ runtime, connector, connection });
  return { repository, runtime, connector, connection };
}

function safePayload(input: { session_id: string; offset: number; role?: "user" | "assistant" }): CodexHistorySourcePayload {
  const record = input.role
    ? {
        kind: "message" as const,
        byte_offset: input.offset,
        byte_length: 40,
        record_sha256: "b".repeat(64),
        timestamp: fixedTimestamp,
        session_id: input.session_id,
        turn_id: "synthetic-turn",
        role: input.role,
        text_parts: ["Synthetic conformance message."],
        omitted_non_text_parts: 0,
      }
    : {
        kind: "session_meta" as const,
        byte_offset: input.offset,
        byte_length: 100,
        record_sha256: "a".repeat(64),
        timestamp: fixedTimestamp,
        session_id: input.session_id,
        source: "fixture",
        originator: "Synthetic Test Harness",
        cli_version: "0.145.0",
        model_provider: "synthetic-provider",
        workspace_path: "/workspace/conformance",
      };
  return {
    version: 1,
    parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT,
    scope: "sessions",
    relative_path: "2026/07/27/rollout-conformance.jsonl",
    session_id: input.session_id,
    from_offset: input.offset,
    through_offset: input.offset + record.byte_length + 1,
    committed_prefix_sha256: "c".repeat(64),
    observed_file_size: input.offset + record.byte_length + 1,
    observed_mtime_ms: 1,
    records: [record],
    excluded_record_counts: {
      developer_or_system_message: 0,
      reasoning: 0,
      tool_call: 0,
      tool_result: 0,
      world_state: 0,
      event_duplicate: 0,
      instruction_or_context: 0,
      token_or_rate_metadata: 0,
      compaction: 0,
      image_or_attachment: 0,
    },
  };
}

test("Codex Connector Kit passes deterministic conformance and exact replay identity", async () => {
  const connection = codexHistorySourceConnection({ id: "codex-history:conformance", privacy: privatePolicy() });
  const cases = [
    { name: "session", payload: safePayload({ session_id: "conformance-session", offset: 0 }), schema: "capture.codex.session@1" },
    { name: "message", payload: safePayload({ session_id: "conformance-session", offset: 101, role: "assistant" }), schema: "capture.codex.message@1" },
  ];
  const report = await runConnectorConformance({
    kit: CODEX_HISTORY_CONNECTOR_KIT,
    connection,
    cases: cases.map(item => ({
      name: item.name,
      payload: item.payload,
      captured_at: fixedTimestamp,
      expected_candidate_count: 1,
      expected_schemas: [item.schema],
      assert_lossless({ payload, candidates }) {
        const representation = candidates[0]?.representation;
        assert.equal(representation?.form, "inline");
        if (representation?.form === "inline") assert.deepEqual(representation.value, payload.records[0]);
        assert.deepEqual(candidates[0]?.policy, connection.privacy);
      },
    })),
    malformed_payloads: [{ version: 1, parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT, records: [] }],
    async submit({ payload, captured_at }) {
      return CODEX_HISTORY_CONNECTOR_KIT.adapt({ connection, payload, captured_at });
    },
    replay_identity(candidates) {
      return candidates.map(candidate => ({
        idempotency_key: candidate.idempotency_key,
        source: candidate.source,
        schema: candidate.schema,
      }));
    },
  });
  assert.equal(report.malformed_payloads_rejected, 1);
  assert.deepEqual(report.cases.map(item => item.schemas[0]), ["capture.codex.session@1", "capture.codex.message@1"]);
});

test("complete records commit once, restart is idle, and archive moves preserve session identity", async () => {
  const home = await syntheticHome("minimal-session.jsonl");
  const harness = await setup({ root: home.root });
  try {
    await harness.connector.health(harness.connection);
    const batches: CaptureBatch[] = [];
    for await (const batch of harness.connector.open(harness.connection, {
      delivery: "pull",
      checkpoint: { connection_id: harness.connection.id, revision: 0, cursor: {}, updated_at: fixedTimestamp },
      parameters: {},
    })) batches.push(batch);
    assert.equal(batches.length, 1);
    const first = await harness.runtime.submitBatch(batches[0]);
    const replay = await harness.runtime.submitBatch(batches[0]);
    assert.equal(first.receipts.length, 3);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipts, first.receipts);
    assert.equal((await harness.repository.listEvents()).length, 1);
    const initialViews = await harness.repository.query({ role: "raw", revisions: "all", limit: 20 });
    assert.equal(initialViews.length, 3);
    const session = initialViews.find(view => view.schema.name === "capture.codex.session");
    const messages = initialViews.filter(view => view.schema.name === "capture.codex.message");
    assert.equal(session?.provenance.capture?.source_id, "codex-session:synthetic-session-001");
    assert.equal(session?.provenance.capture?.identity, "stable_source");
    assert.equal(messages.length, 2);
    assert.equal(new Set(messages.map(view => view.id)).size, 2);
    assert.deepEqual(session?.policy, privatePolicy());
    assert.equal((await harness.repository.query({ text: "synthetic connector state" })).length, 0);

    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull", {}), []);
    await rename(home.active, home.archived);
    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull", {}), []);

    const duplicateText = "A repeated synthetic message remains an independent occurrence.";
    await appendFile(home.archived, [
      messageEnvelope("2026-07-27T01:00:04.000Z", "assistant", duplicateText),
      messageEnvelope("2026-07-27T01:00:05.000Z", "assistant", duplicateText),
    ].join(""));
    const appended = await harness.runtime.run(harness.connection.id, "pull", {});
    assert.equal(appended[0]?.receipts.length, 2);
    const allMessages = (await harness.repository.query({ schema_name: "capture.codex.message", role: "raw", revisions: "all", limit: 20 }));
    assert.equal(allMessages.length, 4);
    assert.equal(new Set(allMessages.map(view => view.id)).size, 4);
    const checkpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    const fileState = (checkpoint?.cursor as { files?: Record<string, { scope?: string }> }).files?.["synthetic-session-001"];
    assert.equal(fileState?.scope, "archived_sessions");

    const restarted = await setup({ root: home.root, repository: harness.repository });
    assert.deepEqual(await restarted.runtime.run(restarted.connection.id, "pull", {}), []);
  } finally {
    harness.repository.close();
    await home.cleanup();
  }
});

test("current official SessionMeta context is validated and structurally excluded", async () => {
  const home = await syntheticHome("current-session-meta.jsonl");
  const harness = await setup({ root: home.root });
  try {
    await harness.connector.health(harness.connection);
    const batches: CaptureBatch[] = [];
    for await (const batch of harness.connector.open(harness.connection, {
      delivery: "pull",
      checkpoint: { connection_id: harness.connection.id, revision: 0, cursor: {}, updated_at: fixedTimestamp },
      parameters: {},
    })) batches.push(batch);
    assert.equal(batches.length, 1);
    assert.equal(
      (batches[0]?.metadata.excluded_record_counts as Record<string, number>).instruction_or_context,
      4,
    );
    const committed = await harness.runtime.submitBatch(batches[0]!);
    assert.equal(committed.receipts.length, 2);
    const views = await harness.repository.query({ role: "raw", revisions: "all", limit: 10 });
    const session = views.find(view => view.schema.name === "capture.codex.session");
    assert.ok(session);
    const serialized = JSON.stringify(session);
    assert.doesNotMatch(serialized, /context_window|window_id|history_mode|repository_url|commit_hash/);
    assert.doesNotMatch(serialized, /SYNTHETIC_REVIEW_(?:INSTRUCTION|HINT|OUTPUT)_MUST_NOT_SURVIVE/);
    assert.equal(session.metadata.parser_contract, CODEX_ROLLOUT_PARSER_CONTRACT);
    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull", {}), []);
  } finally {
    harness.repository.close();
    await home.cleanup();
  }
});

test("structural exclusions never enter candidates while text parts retain offset evidence", async () => {
  const home = await syntheticHome("excluded-records.jsonl");
  const connector = new CodexHistoryCaptureConnector({ codex_home: home.root, now: deterministicClock() });
  const connection = codexHistorySourceConnection({ id: "codex-history:excluded", privacy: privatePolicy() });
  try {
    await connector.health(connection);
    const batches: CaptureBatch[] = [];
    for await (const batch of connector.open(connection, {
      delivery: "pull",
      checkpoint: { connection_id: connection.id, revision: 0, cursor: {}, updated_at: fixedTimestamp },
      parameters: {},
    })) batches.push(batch);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.candidates.length, 2);
    const serialized = JSON.stringify(batches);
    for (const marker of [
      "SYNTHETIC_DEVELOPER_CONTENT_MUST_NOT_SURVIVE",
      "SYNTHETIC_REASONING_MUST_NOT_SURVIVE",
      "SYNTHETIC_TOOL_INPUT_MUST_NOT_SURVIVE",
      "SYNTHETIC_TOOL_OUTPUT_MUST_NOT_SURVIVE",
      "SYNTHETIC_WORLD_STATE_MUST_NOT_SURVIVE",
      "SYNTHETIC_DUPLICATE_MUST_NOT_SURVIVE",
      "SYNTHETIC_COMPACTION_MUST_NOT_SURVIVE",
      "SYNTHETIC_IMAGE_DATA_MUST_NOT_SURVIVE",
      "PARENT_METADATA_MUST_NOT_SURVIVE",
    ]) assert.doesNotMatch(serialized, new RegExp(marker));
    const counts = batches[0]?.metadata.excluded_record_counts as Record<string, number>;
    assert.equal(counts.developer_or_system_message, 1);
    assert.equal(counts.reasoning, 1);
    assert.equal(counts.tool_call, 1);
    assert.equal(counts.tool_result, 1);
    assert.equal(counts.world_state, 1);
    assert.equal(counts.event_duplicate, 1);
    assert.equal(counts.token_or_rate_metadata, 1);
    assert.equal(counts.compaction, 1);
    assert.equal(counts.image_or_attachment, 1);
    const message = batches[0]?.candidates.find(candidate => candidate.schema.name === "capture.codex.message");
    assert.equal(message?.representation.form, "inline");
    if (message?.representation.form === "inline") {
      const value = message.representation.value as { text_parts: string[]; omitted_non_text_parts: number };
      assert.deepEqual(value.text_parts, ["First synthetic text part.", "Second synthetic text part."]);
      assert.equal(value.omitted_non_text_parts, 1);
    }
  } finally {
    await home.cleanup();
  }
});

test("partial tails resume at the exact byte offset and admit the record once", async () => {
  const home = await syntheticHome("minimal-session.jsonl");
  const lines = (await readFile(home.active, "utf8")).trimEnd().split("\n");
  const metadata = `${lines[0]}\n`;
  const message = `${lines[2]}\n`;
  const split = Math.floor(message.length / 2);
  await writeFile(home.active, metadata + message.slice(0, split));
  const harness = await setup({ root: home.root });
  try {
    const first = await harness.runtime.run(harness.connection.id, "pull", {});
    assert.equal(first[0]?.receipts.length, 1);
    assert.equal((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.cursor.files !== undefined, true);
    await appendFile(home.active, message.slice(split));
    const second = await harness.runtime.run(harness.connection.id, "pull", {});
    assert.equal(second[0]?.receipts.length, 1);
    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull", {}), []);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 2);
  } finally {
    harness.repository.close();
    await home.cleanup();
  }
});

test("rollout symlinks and symlinked ancestors fail without disclosing source paths", async () => {
  const linkedHome = await syntheticHome("minimal-session.jsonl");
  const linkedTarget = join(linkedHome.root, "rollout-target.jsonl");
  await rename(linkedHome.active, linkedTarget);
  await symlink(linkedTarget, linkedHome.active);
  const linked = await setup({ root: linkedHome.root });
  try {
    await assert.rejects(
      linked.runtime.run(linked.connection.id, "pull", {}),
      (error: unknown) => {
        assert.ok(error instanceof CaptureRuntimeError);
        assert.equal(error.code, "codex_source_symlink_forbidden");
        assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), new RegExp(linkedHome.root));
        return true;
      },
    );
    assert.equal((await linked.repository.getCaptureCheckpoint(linked.connection.id))?.revision, 0);
  } finally {
    linked.repository.close();
    await linkedHome.cleanup();
  }

  const ancestorHome = await syntheticHome("minimal-session.jsonl");
  const originalDirectory = dirname(ancestorHome.active);
  const movedDirectory = join(ancestorHome.root, "sessions", "moved-day");
  let replaced = false;
  const gate: CodexContentGate = {
    async inspect() {
      if (!replaced) {
        replaced = true;
        await rename(originalDirectory, movedDirectory);
        await symlink(movedDirectory, originalDirectory, "dir");
      }
      return { rule_ids: [] };
    },
  };
  const ancestor = await setup({ root: ancestorHome.root, content_gate: gate });
  try {
    await assert.rejects(
      ancestor.runtime.run(ancestor.connection.id, "pull", {}),
      (error: unknown) => {
        assert.ok(error instanceof CaptureRuntimeError);
        assert.equal(error.code, "codex_source_symlink_forbidden");
        assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), new RegExp(ancestorHome.root));
        return true;
      },
    );
    assert.equal((await ancestor.repository.getCaptureCheckpoint(ancestor.connection.id))?.revision, 0);
    assert.equal((await ancestor.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
  } finally {
    ancestor.repository.close();
    await ancestorHome.cleanup();
  }
});

test("mutate-plus-append during content inspection fails before batch or checkpoint", async () => {
  const home = await syntheticHome("minimal-session.jsonl");
  let mutated = false;
  const gate: CodexContentGate = {
    async inspect() {
      if (!mutated) {
        mutated = true;
        const source = await readFile(home.active, "utf8");
        const changed = source.replace("synthetic-project", "synthetic-projecx");
        await writeFile(home.active, changed + excludedReasoningEnvelope("2026-07-27T02:30:00.000Z"));
      }
      return { rule_ids: [] };
    },
  };
  const harness = await setup({ root: home.root, content_gate: gate });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_source_changed_during_read",
    );
    assert.equal((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.revision, 0);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
  } finally {
    harness.repository.close();
    await home.cleanup();
  }
});

test("messages-only configuration and excluded-only progress fail explicitly", async () => {
  const unsupportedHome = await syntheticHome("minimal-session.jsonl");
  const unsupportedConnector = new CodexHistoryCaptureConnector({ codex_home: unsupportedHome.root });
  const baseConnection = codexHistorySourceConnection({ id: "codex-history:unsupported", privacy: privatePolicy() });
  const unsupportedConnection = {
    ...baseConnection,
    configuration: { ...baseConnection.configuration, content_mode: "metadata_only" },
  };
  try {
    await assert.rejects(
      unsupportedConnector.health(unsupportedConnection),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_source_contract_incompatible",
    );
  } finally {
    await unsupportedHome.cleanup();
  }

  const excludedHome = await syntheticHome("minimal-session.jsonl");
  const excluded = await setup({ root: excludedHome.root });
  try {
    await excluded.runtime.run(excluded.connection.id, "pull", {});
    const checkpoint = await excluded.repository.getCaptureCheckpoint(excluded.connection.id);
    const viewCount = (await excluded.repository.query({ role: "raw", revisions: "all", limit: 20 })).length;
    await appendFile(excludedHome.active, excludedReasoningEnvelope("2026-07-27T02:31:00.000Z"));
    await assert.rejects(
      excluded.runtime.run(excluded.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError
        && error.code === "codex_checkpoint_only_transition_unsupported",
    );
    assert.deepEqual(await excluded.repository.getCaptureCheckpoint(excluded.connection.id), checkpoint);
    assert.equal((await excluded.repository.query({ role: "raw", revisions: "all", limit: 20 })).length, viewCount);
  } finally {
    excluded.repository.close();
    await excludedHome.cleanup();
  }
});

test("tracked session disappearance and checkpoint manifest tampering fail closed", async () => {
  const missingHome = await syntheticHome("minimal-session.jsonl");
  const missing = await setup({ root: missingHome.root });
  try {
    await missing.runtime.run(missing.connection.id, "pull", {});
    const checkpoint = await missing.repository.getCaptureCheckpoint(missing.connection.id);
    await rm(missingHome.active);
    await assert.rejects(
      missing.runtime.run(missing.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_tracked_session_missing",
    );
    assert.deepEqual(await missing.repository.getCaptureCheckpoint(missing.connection.id), checkpoint);
  } finally {
    missing.repository.close();
    await missingHome.cleanup();
  }

  const manifestHome = await syntheticHome("minimal-session.jsonl");
  const manifest = await setup({ root: manifestHome.root });
  try {
    await manifest.runtime.run(manifest.connection.id, "pull", {});
    const checkpoint = await manifest.repository.getCaptureCheckpoint(manifest.connection.id);
    assert.ok(checkpoint);
    const viewCount = (await manifest.repository.query({ role: "raw", revisions: "all", limit: 20 })).length;
    const cursorFiles = checkpoint.cursor.files as Record<string, unknown>;
    const trackedFile = Object.values(cursorFiles)[0];
    assert.ok(trackedFile);
    const mismatchedKeyCursor = {
      ...checkpoint.cursor,
      files: { "different-session-key": trackedFile },
    };
    await manifest.connector.health(manifest.connection);
    await assert.rejects(
      async () => {
        for await (const _batch of manifest.connector.open(manifest.connection, {
          delivery: "pull",
          checkpoint: { ...checkpoint, cursor: mismatchedKeyCursor },
          parameters: {},
        })) {
          assert.fail("A key-mismatched checkpoint must not yield a batch");
        }
      },
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_checkpoint_incompatible",
    );
    assert.deepEqual(await manifest.repository.getCaptureCheckpoint(manifest.connection.id), checkpoint);
    assert.equal((await manifest.repository.query({ role: "raw", revisions: "all", limit: 20 })).length, viewCount);

    const corruptedCursor = {
      ...checkpoint.cursor,
      discovery_manifest_sha256: "0".repeat(64),
    };
    await assert.rejects(
      async () => {
        for await (const _batch of manifest.connector.open(manifest.connection, {
          delivery: "pull",
          checkpoint: { ...checkpoint, cursor: corruptedCursor },
          parameters: {},
        })) {
          assert.fail("A corrupt checkpoint must not yield a batch");
        }
      },
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_checkpoint_incompatible",
    );
    assert.deepEqual(await manifest.repository.getCaptureCheckpoint(manifest.connection.id), checkpoint);
  } finally {
    manifest.repository.close();
    await manifestHome.cleanup();
  }
});

test("unknown envelopes and rewritten committed prefixes fail without cursor advancement", async () => {
  const unknownHome = await syntheticHome("unknown-envelope.jsonl");
  const unknown = await setup({ root: unknownHome.root });
  try {
    await assert.rejects(
      unknown.runtime.run(unknown.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_source_contract_incompatible",
    );
    assert.equal((await unknown.repository.getCaptureCheckpoint(unknown.connection.id))?.revision, 0);
    assert.equal((await unknown.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
  } finally {
    unknown.repository.close();
    await unknownHome.cleanup();
  }

  const contentHome = await syntheticHome("minimal-session.jsonl");
  const content = await setup({ root: contentHome.root });
  try {
    const meta = (await readFile(contentHome.active, "utf8")).split("\n")[0]!;
    await writeFile(contentHome.active, `${meta}\n${JSON.stringify({
      timestamp: "2026-07-27T03:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "future_text_part", text: "must fail compatibility" }],
      },
    })}\n`);
    await assert.rejects(
      content.runtime.run(content.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_source_contract_incompatible",
    );
    assert.equal((await content.repository.getCaptureCheckpoint(content.connection.id))?.revision, 0);
  } finally {
    content.repository.close();
    await contentHome.cleanup();
  }

  const rewrittenHome = await syntheticHome("minimal-session.jsonl");
  const rewritten = await setup({ root: rewrittenHome.root });
  try {
    await rewritten.runtime.run(rewritten.connection.id, "pull", {});
    const before = await rewritten.repository.getCaptureCheckpoint(rewritten.connection.id);
    const source = await readFile(rewrittenHome.active, "utf8");
    await writeFile(rewrittenHome.active, source.replace("synthetic-project", "synthetic-projecx"));
    await assert.rejects(
      rewritten.runtime.run(rewritten.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_append_history_rewritten",
    );
    assert.deepEqual(await rewritten.repository.getCaptureCheckpoint(rewritten.connection.id), before);
  } finally {
    rewritten.repository.close();
    await rewrittenHome.cleanup();
  }
});

test("secret matches fail before batch formation with content-free persisted diagnostics", async () => {
  const home = await syntheticHome("minimal-session.jsonl");
  const meta = (await readFile(home.active, "utf8")).split("\n")[0]!;
  const canary = ["ghp", "_", "A".repeat(36)].join("");
  const gateResult = await new SecretlintRecommendedContentGate().inspect([canary]);
  assert.ok(gateResult.rule_ids.length > 0);
  await writeFile(home.active, `${meta}\n${JSON.stringify({
    timestamp: "2026-07-27T04:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: canary.slice(0, 12) },
        { type: "input_text", text: canary.slice(12) },
      ],
    },
  })}\n`);
  const harness = await setup({ root: home.root });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "codex_secret_detected",
    );
    assert.equal((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.revision, 0);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
    assert.deepEqual(await harness.repository.listCaptureDeadLetters(harness.connection.id), []);
    const persisted = JSON.stringify({
      trace: await harness.repository.getCaptureTrace(harness.connection.id),
      health: await harness.runtime.health(harness.connection.id),
    });
    assert.doesNotMatch(persisted, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(persisted, new RegExp(home.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(persisted, /codex_secret_detected/);
  } finally {
    harness.repository.close();
    await home.cleanup();
  }
});

test("terminal Runtime failure dead-letters only the privacy-gated batch", async () => {
  const home = await syntheticHome("excluded-records.jsonl");
  const repository = new SqliteViewRepository(":memory:");
  const failingRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "commitCaptureBatch") {
        return async () => {
          throw new CaptureRuntimeError("Synthetic storage failure", "storage_failure", "storage", true, {});
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as CaptureRuntimeRepository;
  const harness = await setup({ root: home.root, repository, runtime_repository: failingRepository });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull", {}),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "storage_failure",
    );
    const deadLetters = await repository.listCaptureDeadLetters(harness.connection.id);
    assert.equal(deadLetters.length, 1);
    const serialized = JSON.stringify(deadLetters[0]);
    assert.doesNotMatch(serialized, /SYNTHETIC_(?:DEVELOPER|REASONING|TOOL|WORLD_STATE|DUPLICATE|COMPACTION|IMAGE)/);
    assert.doesNotMatch(serialized, new RegExp(home.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(serialized, /First synthetic text part/);
    assert.equal((await repository.getCaptureCheckpoint(harness.connection.id))?.revision, 0);
  } finally {
    repository.close();
    await home.cleanup();
  }
});

function messageEnvelope(timestamp: string, role: "user" | "assistant", text: string): string {
  const contentType = role === "assistant" ? "output_text" : "input_text";
  return `${JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: contentType, text }] },
  })}\n`;
}

function excludedReasoningEnvelope(timestamp: string): string {
  return `${JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "reasoning",
      id: "synthetic-reasoning",
      summary: [],
      content: null,
      encrypted_content: "SYNTHETIC_EXCLUDED_ONLY_CONTENT",
      internal_chat_message_metadata_passthrough: {},
    },
  })}\n`;
}

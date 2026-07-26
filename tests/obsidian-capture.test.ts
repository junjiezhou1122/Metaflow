import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CaptureIngress,
  CaptureRuntimeError,
  ConnectorRuntime,
  runConnectorConformance,
  type CaptureCheckpoint,
} from "@info/capture";
import { ViewRepositoryError } from "@info/view";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  OBSIDIAN_CONNECTOR_KIT,
  OBSIDIAN_IDENTITY_POLICY,
  OBSIDIAN_MAX_PRIOR_PATHS,
  OBSIDIAN_PARSER_CONTRACT,
  OBSIDIAN_SECRET_POLICY,
  ObsidianCaptureAdapter,
  ObsidianParserError,
  SecretlintObsidianSecretGate,
  configureObsidianCapture,
  cursorFromDocuments,
  discoverMarkdownFiles,
  obsidianSourceConnection,
  parseObsidianMarkdown,
  planObsidianOperations,
  readSafeMarkdownFile,
  resolveVaultRoot,
  type ObsidianConfiguration,
  type ObsidianFileReadHooks,
  type ObsidianReadFile,
  type ObsidianSourcePayload,
  type ObsidianWatcherAccelerator,
} from "../packages/adapters/obsidian-capture/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "obsidian-vault");
const capturedAt = "2026-07-27T08:00:00.000Z";

function policy() {
  return {
    owner: "user:test",
    visibility: "private" as const,
    privacy: "sensitive" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: true,
    labels: ["obsidian"],
  };
}

function configuration(root: string): ObsidianConfiguration {
  return {
    vault_id: "synthetic-vault",
    vault_root: root,
    include: ["**/*.md"],
    max_file_bytes: 1_000_000,
    identity_policy: OBSIDIAN_IDENTITY_POLICY,
    parser_contract: OBSIDIAN_PARSER_CONTRACT,
    secret_policy: OBSIDIAN_SECRET_POLICY,
  };
}

function syntheticReadFile(input: {
  relative_path: string;
  file_resource_id: string;
  sha256: string;
  markdown?: string;
}): ObsidianReadFile {
  const markdown = input.markdown ?? "synthetic";
  const [discovered_device = "1", discovered_inode = "1"] = input.file_resource_id.split(":");
  return {
    relative_path: input.relative_path,
    absolute_path: `/synthetic/${input.relative_path}`,
    root_device: "1",
    root_resource_id: "root",
    discovered_device,
    discovered_inode,
    file_resource_id: input.file_resource_id,
    size: Buffer.byteLength(markdown),
    mtime_ms: 2,
    sha256: input.sha256,
    markdown,
    parsed: { frontmatter: null, headings: [], links: [] },
  };
}

class FakeWatcher implements ObsidianWatcherAccelerator {
  loads = 0;
  writes: number[] = [];
  failWrite = false;
  recovered = false;
  async load() {
    this.loads += 1;
    return { reference: null, changed_paths: [], recovered: this.recovered };
  }
  async write(input: { checkpoint_revision: number }) {
    this.writes.push(input.checkpoint_revision);
    if (this.failWrite) throw new Error("synthetic post-commit crash");
    return { path: `snapshot-${input.checkpoint_revision}.bin` as const, sha256: "a".repeat(64) };
  }
}

async function temporaryVault(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metaflow-obsidian-test-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

async function setup(root: string, options: { watcher?: FakeWatcher; enabled?: boolean; file_read_hooks?: ObsidianFileReadHooks } = {}) {
  const repository = new SqliteViewRepository(":memory:");
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository }), { now: () => capturedAt });
  const watcher = options.watcher ?? new FakeWatcher();
  const connector = new ObsidianCaptureAdapter({ now: () => capturedAt, watcher, file_read_hooks: options.file_read_hooks });
  const connection = obsidianSourceConnection({
    configuration: configuration(root),
    privacy: policy(),
    enabled: options.enabled,
  });
  await configureObsidianCapture({ runtime, connector, connection });
  return { repository, runtime, connector, connection, watcher };
}

test("structured parser oracle covers required Obsidian syntax and preserves code exclusions", async () => {
  const markdown = await readFile(join(fixtureRoot, "oracle.md"), "utf8");
  const parsed = parseObsidianMarkdown(markdown);
  assert.deepEqual(parsed.frontmatter, {
    raw: [
      "title: Synthetic Oracle",
      "aliases: [Oracle Alias, Second Alias]",
      "tags: [fixture, parser]",
      "published: 2026-07-27",
      "source: https://example.test/reference",
      "nested:",
      "  enabled: true",
    ].join("\n"),
    value: {
      title: "Synthetic Oracle",
      aliases: ["Oracle Alias", "Second Alias"],
      tags: ["fixture", "parser"],
      published: "2026-07-27",
      source: "https://example.test/reference",
      nested: { enabled: true },
    },
  });
  assert.deepEqual(parsed.headings, [
    { depth: 1, text: "Primary Heading", slug: "primary-heading" },
    { depth: 2, text: "Primary Heading", slug: "primary-heading-1" },
  ]);
  assert.deepEqual(parsed.links, [
    { syntax: "wikilink", target: "note" },
    { syntax: "wikilink", target: "note", alias: "Alias" },
    { syntax: "wikilink", target: "note", heading: "Heading" },
    { syntax: "wikilink", target: "note", block_id: "block-id" },
    { syntax: "markdown", target: "../other.md#part", alias: "relative" },
    { syntax: "markdown", target: "https://example.test/path", alias: "external" },
    { syntax: "embed", target: "image.png", media_dimensions: "200x300" },
    { syntax: "embed", target: "embedded note", heading: "heading" },
  ]);
  assert.equal(JSON.stringify(parsed).includes("inline-code"), false);
  assert.equal(JSON.stringify(parsed).includes("fenced-code"), false);
});

test("parser rejects malformed, duplicate, aliased, tagged, and unparsed constructs explicitly", () => {
  for (const [source, code] of [
    ["---\ntitle: [broken\n---\n", "obsidian_frontmatter_invalid"],
    ["---\ntitle: one\ntitle: two\n---\n", "obsidian_frontmatter_invalid"],
    ["---\nbase: &base value\ncopy: *base\n---\n", "obsidian_frontmatter_unsupported"],
    ["---\nvalue: !custom data\n---\n", "obsidian_frontmatter_unsupported"],
    ["---\ntitle: one\n---\nbody\n---\ntitle: two\n---\n", "obsidian_frontmatter_unsupported"],
    ["[[unterminated", "obsidian_markdown_incompatible"],
  ] as const) {
    assert.throws(
      () => parseObsidianMarkdown(source),
      (error: unknown) => error instanceof ObsidianParserError && error.code === code,
    );
  }
});

test("pre-batch secret gate returns content-free evidence for scanner and frontmatter matches", async () => {
  const gate = new SecretlintObsidianSecretGate();
  const canary = ["ghp", "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJ"].join("_").replace("_A", "A");
  const markdown = `# synthetic\n${canary}`;
  await assert.rejects(
    gate.assertSafe({
      connection_id: "obsidian:test",
      relative_path: "safe/path.md",
      markdown,
      content_sha256: createHash("sha256").update(markdown).digest("hex"),
      frontmatter: null,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CaptureRuntimeError);
      assert.equal(error.code, "obsidian_secret_detected");
      assert.doesNotMatch(JSON.stringify(error), new RegExp(canary));
      assert.equal(error.details.rule_id, "@secretlint/secretlint-rule-github");
      return true;
    },
  );
  const urlMarkdown = "---\nsource: https://example.test/?token=synthetic\n---\n";
  await assert.rejects(
    gate.assertSafe({
      connection_id: "obsidian:test",
      relative_path: "safe/frontmatter.md",
      markdown: urlMarkdown,
      content_sha256: createHash("sha256").update(urlMarkdown).digest("hex"),
      frontmatter: parseObsidianMarkdown(urlMarkdown).frontmatter,
    }),
    (error: unknown) => error instanceof CaptureRuntimeError
      && error.code === "obsidian_secret_detected"
      && error.details.rule_id === "obsidian/frontmatter-credential-url",
  );
});

test("reader enforces no-follow containment, size, UTF-8, and fstat stability", async () => {
  const outside = await temporaryVault({ "outside.md": "outside" });
  const root = await temporaryVault({
    "valid.md": "# Valid",
    "large.md": "x".repeat(100),
    "invalid.md": Buffer.from([0xc3, 0x28]),
  });
  try {
    await symlink(join(outside, "outside.md"), join(root, "escape.md"));
    const identity = await resolveVaultRoot(configuration(root));
    await assert.rejects(
      discoverMarkdownFiles(identity, 100),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_symlink_forbidden",
    );
    await unlink(join(root, "escape.md"));
    const discovered = await discoverMarkdownFiles(identity, 100);
    const gate = { assertSafe: async () => {} };
    await assert.rejects(
      readSafeMarkdownFile({ root: identity, connection_id: "obsidian:test", file: discovered.find(file => file.relative_path === "large.md")!, max_file_bytes: 10, secret_gate: gate }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_file_too_large",
    );
    await assert.rejects(
      readSafeMarkdownFile({ root: identity, connection_id: "obsidian:test", file: discovered.find(file => file.relative_path === "invalid.md")!, max_file_bytes: 1_000, secret_gate: gate }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_invalid_utf8",
    );
    const valid = discovered.find(file => file.relative_path === "valid.md")!;
    await assert.rejects(
      readSafeMarkdownFile({
        root: identity,
        connection_id: "obsidian:test",
        file: valid,
        max_file_bytes: 1_000,
        secret_gate: gate,
        hooks: { afterRead: () => writeFile(valid.absolute_path, "# Changed after read") },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_file_changed_during_read",
    );
    await assert.rejects(
      readSafeMarkdownFile({
        root: identity,
        connection_id: "obsidian:test",
        file: {
          relative_path: "../outside.md",
          absolute_path: join(outside, "outside.md"),
          root_device: identity.device,
          root_resource_id: identity.resource_id,
          discovered_device: "0",
          discovered_inode: "0",
          file_resource_id: "0:0",
          size: 7,
          mtime_ms: 0,
        },
        max_file_bytes: 1_000,
        secret_gate: gate,
      }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_path_escape",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ancestor replacement after discovery fails opened-handle identity before admission", async () => {
  const root = await temporaryVault({ "folder/note.md": "# Original" });
  let replaced = false;
  const harness = await setup(root, {
    file_read_hooks: {
      async beforeOpen({ relative_path }) {
        if (replaced || relative_path !== "folder/note.md") return;
        replaced = true;
        await rename(join(root, "folder"), join(root, "discovered-folder"));
        await mkdir(join(root, "folder"));
        await writeFile(join(root, "folder", "note.md"), "# Replacement");
      },
    },
  });
  try {
    const checkpointBefore = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_file_identity_changed",
    );
    assert.deepEqual(await harness.repository.getCaptureCheckpoint(harness.connection.id), checkpointBefore);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ancestor symlink swap to the discovered inode fails containment before content scanning", async () => {
  const root = await temporaryVault({ "folder/note.md": "# Original" });
  const outside = await temporaryVault({});
  let secretScanStarted = false;
  try {
    const identity = await resolveVaultRoot(configuration(root));
    const [file] = await discoverMarkdownFiles(identity, 10);
    assert.ok(file);
    await assert.rejects(
      readSafeMarkdownFile({
        root: identity,
        connection_id: "obsidian:test",
        file,
        max_file_bytes: 1_000,
        secret_gate: { assertSafe: async () => { secretScanStarted = true; } },
        hooks: {
          async beforeOpen() {
            await rename(join(root, "folder"), join(outside, "moved-folder"));
            await symlink(join(outside, "moved-folder"), join(root, "folder"));
          },
        },
      }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_path_escape",
    );
    assert.equal(secretScanStarted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Connector Kit conformance is deterministic, lossless, strict, and relation-free", async () => {
  const markdown = await readFile(join(fixtureRoot, "plain.md"), "utf8");
  const sha256 = createHash("sha256").update(markdown).digest("hex");
  const connection = obsidianSourceConnection({ configuration: configuration("synthetic-root-not-opened"), privacy: policy() });
  const upsert: ObsidianSourcePayload = {
    version: 1,
    operation: "upsert",
    vault_id: "synthetic-vault",
    document_id: "document-one",
    relative_path: "plain.md",
    observed_at: capturedAt,
    revision: { sha256, byte_length: Buffer.byteLength(markdown), mtime_ms: 1 },
    encoding: "utf-8",
    markdown,
  };
  const deletion: ObsidianSourcePayload = {
    version: 1,
    operation: "delete",
    vault_id: "synthetic-vault",
    document_id: "document-one",
    relative_path: "plain.md",
    observed_at: capturedAt,
    prior_sha256: sha256,
  };
  const report = await runConnectorConformance({
    kit: OBSIDIAN_CONNECTOR_KIT,
    connection,
    cases: [
      {
        name: "exact-upsert",
        payload: upsert,
        captured_at: capturedAt,
        expected_candidate_count: 1,
        expected_schemas: ["capture.obsidian.document@1"],
        assert_lossless({ payload, candidates }) {
          const representation = candidates[0]?.representation;
          assert.equal(representation?.form, "inline");
          if (representation?.form === "inline") {
            assert.equal((representation.value as { markdown: string }).markdown, payload.operation === "upsert" ? payload.markdown : undefined);
          }
          assert.deepEqual(candidates[0]?.relations, []);
          assert.deepEqual(candidates[0]?.policy, connection.privacy);
        },
      },
      {
        name: "source-delete",
        payload: deletion,
        captured_at: capturedAt,
        expected_candidate_count: 1,
        expected_schemas: ["capture.obsidian.document@1"],
        assert_lossless({ candidates }) {
          assert.equal(candidates[0]?.representation.kind, "metaflow.source_tombstone");
        },
      },
    ],
    malformed_payloads: [{ ...upsert, markdown: undefined }, { ...upsert, unknown: true }],
    async submit({ payload, captured_at }) {
      return OBSIDIAN_CONNECTOR_KIT.adapt({ connection, payload, captured_at });
    },
    replay_identity(candidates) {
      return candidates.map(candidate => ({ key: candidate.idempotency_key, source: candidate.source, representation: candidate.representation }));
    },
  });
  assert.equal(report.malformed_payloads_rejected, 2);
});

test("full scan commits revisions, rename identity, exact replay, and confirmed tombstone", async () => {
  const root = await temporaryVault({
    "a.md": "# A\n[[unresolved]]",
    "folder/b.md": "# B",
    ".git/ignored.md": "never read",
    ".obsidian/config.md": "never read",
    "attachment.png": "not fetched",
  });
  const harness = await setup(root);
  try {
    const initial = await harness.runtime.run(harness.connection.id, "pull");
    assert.equal(initial.length, 2);
    assert.deepEqual(harness.watcher.writes, [2]);
    const firstViews = await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "latest", limit: 10 });
    assert.equal(firstViews.length, 2);
    assert.equal(firstViews.every(view => view.relations.length === 0), true);
    const bBefore = firstViews.find(view => JSON.stringify(view.representation.value).includes("folder/b.md"))!;

    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull"), []);
    assert.deepEqual(harness.watcher.writes, [2]);

    await writeFile(join(root, "a.md"), "# A updated\n[[still-unresolved]]");
    const updated = await harness.runtime.run(harness.connection.id, "pull");
    assert.equal(updated.length, 1);
    await rename(join(root, "folder", "b.md"), join(root, "renamed.md"));
    const renamed = await harness.runtime.run(harness.connection.id, "pull");
    assert.equal(renamed.length, 1);
    const latest = await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "latest", limit: 10 });
    const bAfter = latest.find(view => JSON.stringify(view.representation.value).includes("renamed.md"))!;
    assert.equal(bAfter.id, bBefore.id);
    assert.equal(bAfter.revision, 2);

    await unlink(join(root, "a.md"));
    const deleted = await harness.runtime.run(harness.connection.id, "pull");
    assert.equal(deleted.length, 1);
    const all = await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "all", limit: 20 });
    assert.equal(all.some(view => view.representation.kind === "metaflow.source_tombstone"), true);
    const checkpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    assert.ok(checkpoint);
    assert.doesNotMatch(JSON.stringify(checkpoint), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull"), []);
    await writeFile(join(root, "a.md"), "# Reappeared after tombstone");
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_retired_path_reappeared",
    );
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rename deletion retires every identity path and recreation cannot advance durable state", async () => {
  const root = await temporaryVault({ "a.md": "# Stable identity" });
  const harness = await setup(root);
  try {
    await harness.runtime.run(harness.connection.id, "pull");
    const initialCheckpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    assert.ok(initialCheckpoint);
    const documentId = Object.keys(initialCheckpoint.cursor.documents as Record<string, unknown>)[0]!;

    await rename(join(root, "a.md"), join(root, "b.md"));
    await harness.runtime.run(harness.connection.id, "pull");
    await unlink(join(root, "b.md"));
    await harness.runtime.run(harness.connection.id, "pull");

    const beforeRecreate = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    assert.ok(beforeRecreate);
    assert.equal((beforeRecreate.cursor.retired_paths as Record<string, string>)["a.md"], documentId);
    assert.equal((beforeRecreate.cursor.retired_paths as Record<string, string>)["b.md"], documentId);
    const viewsBeforeRecreate = await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "all", limit: 10 });
    assert.equal(viewsBeforeRecreate.length, 3);

    await writeFile(join(root, "a.md"), "# Must not resurrect");
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_retired_path_reappeared",
    );
    assert.deepEqual(await harness.repository.getCaptureCheckpoint(harness.connection.id), beforeRecreate);
    assert.equal(
      (await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "all", limit: 10 })).length,
      viewsBeforeRecreate.length,
    );
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("planner reconciles identity evidence before path and records inode-only replacement", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const previous = cursorFromDocuments("synthetic-vault", {
    "document-a": {
      document_id: "document-a",
      current_relative_path: "a.md",
      prior_paths: [],
      file_resource_id: "1:10",
      last_sha256: hashA,
      byte_length: 1,
      mtime_ms: 1,
    },
    "document-b": {
      document_id: "document-b",
      current_relative_path: "b.md",
      prior_paths: [],
      file_resource_id: "1:20",
      last_sha256: hashB,
      byte_length: 1,
      mtime_ms: 1,
    },
  }, null, { root_device: "1", root_resource_id: "root" }, {});
  assert.throws(
    () => planObsidianOperations({
      connection_id: "obsidian:test",
      vault_id: "synthetic-vault",
      previous,
      files: [syntheticReadFile({ relative_path: "a.md", file_resource_id: "1:20", sha256: hashB, markdown: "B" })],
      observed_at: capturedAt,
      watcher_snapshot: null,
    }),
    (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_path_collision",
  );

  const ambiguousSameDigest = cursorFromDocuments("synthetic-vault", {
    "document-a": { ...previous.documents["document-a"]!, last_sha256: hashA },
    "document-b": { ...previous.documents["document-b"]!, last_sha256: hashA },
  }, null, { root_device: "1", root_resource_id: "root" }, {});
  assert.throws(
    () => planObsidianOperations({
      connection_id: "obsidian:test",
      vault_id: "synthetic-vault",
      previous: ambiguousSameDigest,
      files: [syntheticReadFile({ relative_path: "a.md", file_resource_id: "1:30", sha256: hashA, markdown: "A" })],
      observed_at: capturedAt,
      watcher_snapshot: null,
    }),
    (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_ambiguous",
  );

  const samePath = cursorFromDocuments("synthetic-vault", {
    "document-a": {
      document_id: "document-a",
      current_relative_path: "a.md",
      prior_paths: [],
      file_resource_id: "1:10",
      last_sha256: hashA,
      byte_length: 1,
      mtime_ms: 1,
    },
  }, null, { root_device: "1", root_resource_id: "root" }, {});
  const operations = planObsidianOperations({
    connection_id: "obsidian:test",
    vault_id: "synthetic-vault",
    previous: samePath,
    files: [syntheticReadFile({ relative_path: "a.md", file_resource_id: "1:30", sha256: hashA, markdown: "A" })],
    observed_at: capturedAt,
    watcher_snapshot: null,
  });
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.payload.operation, "upsert");
  assert.equal(operations[0]?.payload.document_id, "document-a");
  assert.equal(operations[0]?.next_cursor.documents["document-a"]?.file_resource_id, "1:30");
});

test("durable path replacement conflict fails without tombstone or checkpoint advancement", async () => {
  const root = await temporaryVault({ "a.md": "A", "b.md": "B" });
  const harness = await setup(root);
  try {
    await harness.runtime.run(harness.connection.id, "pull");
    const checkpointBefore = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    const viewsBefore = await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "all", limit: 10 });
    assert.equal(viewsBefore.length, 2);

    await rename(join(root, "b.md"), join(root, "a.md"));
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_path_collision",
    );
    assert.deepEqual(await harness.repository.getCaptureCheckpoint(harness.connection.id), checkpointBefore);
    const viewsAfter = await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "all", limit: 10 });
    assert.deepEqual(viewsAfter, viewsBefore);
    assert.equal(viewsAfter.some(view => view.representation.kind === "metaflow.source_tombstone"), false);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable inode-only replacement advances exact evidence and enables rename plus edit", async () => {
  const root = await temporaryVault({ "note.md": "same content" });
  const harness = await setup(root);
  try {
    await harness.runtime.run(harness.connection.id, "pull");
    const initialCheckpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    assert.ok(initialCheckpoint);
    const documentId = Object.keys(initialCheckpoint.cursor.documents as Record<string, unknown>)[0]!;
    const initialResource = (initialCheckpoint.cursor.documents as Record<string, { file_resource_id?: string }>)[documentId]?.file_resource_id;
    const initialView = (await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "latest", limit: 10 }))[0]!;

    await writeFile(join(root, ".replacement.md"), "same content");
    await rename(join(root, ".replacement.md"), join(root, "note.md"));
    const replacement = await harness.runtime.run(harness.connection.id, "pull");
    assert.equal(replacement.length, 1);
    const replacementCheckpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    assert.ok(replacementCheckpoint);
    const replacementResource = (replacementCheckpoint.cursor.documents as Record<string, { file_resource_id?: string }>)[documentId]?.file_resource_id;
    assert.notEqual(replacementResource, initialResource);
    assert.equal(replacementCheckpoint.revision, initialCheckpoint.revision + 1);
    const replacementView = (await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "latest", limit: 10 }))[0]!;
    assert.equal(replacementView.id, initialView.id);
    assert.equal(replacementView.revision, 2);
    assert.deepEqual(await harness.runtime.run(harness.connection.id, "pull"), []);

    await rename(join(root, "note.md"), join(root, "renamed.md"));
    await writeFile(join(root, "renamed.md"), "edited after replacement");
    const renamed = await harness.runtime.run(harness.connection.id, "pull");
    assert.equal(renamed.length, 1);
    const finalCheckpoint = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    assert.ok(finalCheckpoint);
    const finalEntry = (finalCheckpoint.cursor.documents as Record<string, { current_relative_path: string; file_resource_id?: string }>)[documentId]!;
    assert.equal(finalEntry.current_relative_path, "renamed.md");
    assert.equal(finalEntry.file_resource_id, replacementResource);
    const finalView = (await harness.repository.query({ schema_name: "capture.obsidian.document", revisions: "latest", limit: 10 }))[0]!;
    assert.equal(finalView.id, initialView.id);
    assert.equal(finalView.revision, 3);
    assert.match(JSON.stringify(finalView.representation), /edited after replacement/);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("identity history and retirement collisions fail explicitly without truncation", () => {
  const sha256 = "a".repeat(64);
  const priorPaths = Array.from({ length: OBSIDIAN_MAX_PRIOR_PATHS }, (_, index) => `prior-${index}.md`);
  const previous = cursorFromDocuments("synthetic-vault", {
    "document-one": {
      document_id: "document-one",
      current_relative_path: "current.md",
      prior_paths: priorPaths,
      file_resource_id: "resource-one",
      last_sha256: sha256,
      byte_length: 4,
      mtime_ms: 1,
    },
  }, null, { root_device: "1", root_resource_id: "root" }, {});
  assert.throws(
    () => planObsidianOperations({
      connection_id: "obsidian:test",
      vault_id: "synthetic-vault",
      previous,
      files: [{
        relative_path: "next.md",
        absolute_path: "/synthetic/next.md",
        root_device: "1",
        root_resource_id: "root",
        discovered_device: "1",
        discovered_inode: "2",
        size: 4,
        mtime_ms: 2,
        file_resource_id: "resource-one",
        sha256,
        markdown: "same",
        parsed: { frontmatter: null, headings: [], links: [] },
      }],
      observed_at: capturedAt,
      watcher_snapshot: null,
    }),
    (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_history_limit_exceeded",
  );

  const colliding = cursorFromDocuments("synthetic-vault", {
    "document-one": {
      document_id: "document-one",
      current_relative_path: "current.md",
      prior_paths: ["claimed.md"],
      last_sha256: sha256,
      byte_length: 4,
      mtime_ms: 1,
    },
  }, null, { root_device: "1", root_resource_id: "root" }, { "claimed.md": "document-two" });
  assert.throws(
    () => planObsidianOperations({
      connection_id: "obsidian:test",
      vault_id: "synthetic-vault",
      previous: colliding,
      files: [],
      observed_at: capturedAt,
      watcher_snapshot: null,
    }),
    (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_path_collision",
  );
});

test("post-commit watcher crash leaves durable checkpoint and restart performs no duplicate commit", async () => {
  const root = await temporaryVault({ "crash.md": "# Crash window" });
  const failingWatcher = new FakeWatcher();
  failingWatcher.failWrite = true;
  const harness = await setup(root, { watcher: failingWatcher });
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_watcher_snapshot_write_failed",
    );
    assert.equal((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.revision, 1);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 1);

    const restartedRuntime = new ConnectorRuntime(harness.repository, new CaptureIngress({ repository: harness.repository }), { now: () => capturedAt });
    const restartedConnector = new ObsidianCaptureAdapter({ now: () => capturedAt, watcher: new FakeWatcher() });
    restartedRuntime.registerConnector(restartedConnector);
    assert.deepEqual(await restartedRuntime.run(harness.connection.id, "pull"), []);
    assert.equal((await harness.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 1);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart rejects a vault root replaced at the same configured path", async () => {
  const root = await temporaryVault({ "identity.md": "# Original root" });
  const movedRoot = `${root}-moved`;
  const harness = await setup(root);
  try {
    await harness.runtime.run(harness.connection.id, "pull");
    await rename(root, movedRoot);
    await mkdir(root);
    await writeFile(join(root, "identity.md"), "# Replacement root");
    const restartedRuntime = new ConnectorRuntime(harness.repository, new CaptureIngress({ repository: harness.repository }), { now: () => capturedAt });
    restartedRuntime.registerConnector(new ObsidianCaptureAdapter({ now: () => capturedAt, watcher: new FakeWatcher() }));
    await assert.rejects(
      restartedRuntime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_checkpoint_incompatible",
    );
    assert.equal((await harness.repository.getCaptureCheckpoint(harness.connection.id))?.revision, 1);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
  }
});

test("ambiguous digest renames and offline rename-plus-edit fail without checkpoint advance", async () => {
  const root = await temporaryVault({ "a.md": "same", "b.md": "same" });
  const harness = await setup(root);
  try {
    await harness.runtime.run(harness.connection.id, "pull");
    const before = await harness.repository.getCaptureCheckpoint(harness.connection.id);
    await copyFile(join(root, "a.md"), join(root, "c.md"));
    await copyFile(join(root, "b.md"), join(root, "d.md"));
    await unlink(join(root, "a.md"));
    await unlink(join(root, "b.md"));
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_ambiguous",
    );
    assert.deepEqual(await harness.repository.getCaptureCheckpoint(harness.connection.id), before);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }

  const editedRoot = await temporaryVault({ "old.md": "old" });
  const edited = await setup(editedRoot);
  try {
    await edited.runtime.run(edited.connection.id, "pull");
    await writeFile(join(editedRoot, "new.md"), "edited during offline rename");
    await unlink(join(editedRoot, "old.md"));
    await assert.rejects(
      edited.runtime.run(edited.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_identity_unresolved",
    );
  } finally {
    edited.repository.close();
    await rm(editedRoot, { recursive: true, force: true });
  }
});

test("secret, unavailable placeholder, paused, and disabled sources fail before admission or source work", async () => {
  const canary = ["ghp", "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJ"].join("_").replace("_A", "A");
  const root = await temporaryVault({ "secret.md": `# blocked\n${canary}` });
  const harness = await setup(root);
  try {
    await assert.rejects(
      harness.runtime.run(harness.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_secret_detected",
    );
    const durable = {
      checkpoint: await harness.repository.getCaptureCheckpoint(harness.connection.id),
      trace: await harness.repository.getCaptureTrace(harness.connection.id),
      dead_letters: await harness.repository.listCaptureDeadLetters(harness.connection.id),
      views: await harness.repository.query({ role: "raw", revisions: "all", limit: 10 }),
    };
    assert.doesNotMatch(JSON.stringify(durable), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(durable), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(durable.dead_letters.length, 0);
    assert.equal(durable.views.length, 0);
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }

  const placeholderRoot = await temporaryVault({ ".note.md.icloud": "placeholder" });
  const placeholder = await setup(placeholderRoot);
  try {
    await assert.rejects(
      placeholder.runtime.run(placeholder.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "obsidian_file_unavailable",
    );
  } finally {
    placeholder.repository.close();
    await rm(placeholderRoot, { recursive: true, force: true });
  }

  const policyRoot = await temporaryVault({ "paused.md": "# Paused" });
  const paused = await setup(policyRoot);
  try {
    await paused.runtime.pause(paused.connection.id);
    await assert.rejects(
      paused.runtime.run(paused.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "connection_paused",
    );
    assert.equal(paused.watcher.loads, 0);
  } finally {
    paused.repository.close();
  }
  const disabled = await setup(policyRoot, { enabled: false });
  try {
    await assert.rejects(
      disabled.runtime.run(disabled.connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "connection_disabled",
    );
    assert.equal(disabled.watcher.loads, 0);
  } finally {
    disabled.repository.close();
    await rm(policyRoot, { recursive: true, force: true });
  }
});

test("storage failure dead-letters the safe batch, freezes checkpoint, and replays exactly", async () => {
  const root = await temporaryVault({ "safe.md": "# Safe DLQ fixture" });
  const base = new SqliteViewRepository(":memory:");
  let failCommit = true;
  const repository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "commitCaptureBatch") {
        return async (...args: Parameters<SqliteViewRepository["commitCaptureBatch"]>) => {
          if (failCommit) {
            throw new ViewRepositoryError("synthetic storage failure", "storage_failure", {
              operation: "capture_commit_batch",
              phase: "synthetic_test",
            });
          }
          return target.commitCaptureBatch(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqliteViewRepository;
  const watcher = new FakeWatcher();
  watcher.recovered = true;
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository }), {
    now: () => capturedAt,
    retry_policy: {
      id: "obsidian-test-no-retry",
      revision: 1,
      max_attempts: 1,
      retryable_codes: ["storage_failure"],
      non_retryable_codes: [],
    },
  });
  const connector = new ObsidianCaptureAdapter({ now: () => capturedAt, watcher });
  const connection = obsidianSourceConnection({ configuration: configuration(root), privacy: policy() });
  await configureObsidianCapture({ runtime, connector, connection });
  try {
    await assert.rejects(
      runtime.run(connection.id, "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "storage_failure",
    );
    assert.equal((await repository.getCaptureCheckpoint(connection.id))?.revision, 0);
    assert.deepEqual(watcher.writes, []);
    const deadLetters = await repository.listCaptureDeadLetters(connection.id, "pending");
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]?.batch.metadata.discovery, "full_rescan_after_watcher_recovery");
    assert.doesNotMatch(JSON.stringify(deadLetters), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    failCommit = false;
    const replay = await runtime.replayDeadLetter(deadLetters[0]!.id);
    assert.equal(replay.replayed, false);
    assert.equal(replay.receipts[0]?.status, "stored");
    assert.equal((await repository.getCaptureCheckpoint(connection.id))?.revision, 1);
    assert.deepEqual(await runtime.run(connection.id, "pull"), []);
    assert.equal((await repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 1);
  } finally {
    base.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale generated batch fails checkpoint CAS after a concurrent scan commits", async () => {
  const root = await temporaryVault({ "race.md": "# One" });
  const harness = await setup(root);
  try {
    await harness.runtime.run(harness.connection.id, "pull");
    await writeFile(join(root, "race.md"), "# Stale");
    const checkpoint = (await harness.repository.getCaptureCheckpoint(harness.connection.id)) as CaptureCheckpoint;
    await harness.connector.health(harness.connection, {});
    const iterator = harness.connector.open(harness.connection, { delivery: "pull", checkpoint, parameters: {} }, {})[Symbol.asyncIterator]();
    const stale = await iterator.next();
    assert.equal(stale.done, false);
    await writeFile(join(root, "race.md"), "# Fresh concurrent value");
    await harness.runtime.run(harness.connection.id, "pull");
    await assert.rejects(
      harness.runtime.submitBatch(stale.value),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "checkpoint_conflict",
    );
  } finally {
    harness.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PersonalizedSourceSmokeConfigSchema,
  PersonalizedSourceSmokeError,
  PersonalizedSourceSmokeEvidenceSchema,
  readPersonalizedSourceSmokeConfig,
  runPersonalizedSourceSmoke,
} from "../scripts/v1/personalized-source-smoke.js";

const NOW = "2026-07-27T08:00:00.000Z";
const PRIVATE_MARKER = "private personalized note marker";

test("selected synthetic Codex and Obsidian sources produce content-free replay and cleanup evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-source-smoke-test-"));
  const note = join(root, "Projects", "private-note.md");
  try {
    await mkdir(join(root, "Projects"));
    await writeFile(note, `# Private note\n\n${PRIVATE_MARKER}\n`, { mode: 0o600 });
    const evidence = await runPersonalizedSourceSmoke({
      version: 1,
      codex_rollouts: [resolve("tests/fixtures/codex-history/minimal-session.jsonl")],
      obsidian_vault_root: root,
      obsidian_notes: ["Projects/private-note.md"],
      obsidian_vault_id: "synthetic-personalized-smoke",
    }, { now: () => NOW, temporary_parent: root });

    PersonalizedSourceSmokeEvidenceSchema.parse(evidence);
    assert.equal(evidence.version, 2);
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.sources.codex_rollouts, 1);
    assert.deepEqual(evidence.sources.obsidian_notes, 1);
    assert.equal(evidence.capture.committed_batches, 2);
    assert.equal(evidence.capture.stored_views, 4);
    assert.match(evidence.capture.view_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.capture.views_truncated, false);
    assert.deepEqual(
      evidence.capture.views.map(view => view.schema.name).sort(),
      ["capture.codex.message", "capture.codex.message", "capture.codex.session", "capture.obsidian.document"],
    );
    assert.ok(evidence.capture.views.every(view => view.ref.view_id.startsWith("view:raw:") && view.ref.revision === 1));
    assert.ok(evidence.capture.connectors.every(connector => connector.replay.submitted_batches === 1));
    assert.ok(evidence.capture.connectors.every(connector => connector.replay.confirmed_exact_replays === 1));
    assert.ok(evidence.capture.connectors.every(connector => connector.replay.post_checkpoint_emitted_batches === 0));
    assert.ok(evidence.capture.connectors.every(connector => connector.replay.post_checkpoint_emitted_receipts === 0));
    assert.ok(evidence.capture.connectors.every(connector => connector.replay.checkpoint_unchanged));
    assert.deepEqual(evidence.cleanup, { workspace_removed: true, database_removed: true });

    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(root)));
    assert.doesNotMatch(serialized, /private-note\.md/);
    assert.doesNotMatch(serialized, /Projects\/private-note/);
    assert.doesNotMatch(serialized, new RegExp(PRIVATE_MARKER));
    assert.doesNotMatch(serialized, /Summarize the synthetic connector state/);
    assert.deepEqual(await readdir(root), ["Projects"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config loading is explicit and rejects ambiguous or relative selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-source-smoke-config-"));
  try {
    const configPath = join(root, "smoke.json");
    const config = {
      version: 1,
      codex_rollouts: [resolve("tests/fixtures/codex-history/minimal-session.jsonl")],
      obsidian_vault_root: root,
      obsidian_notes: ["selected.md"],
      obsidian_vault_id: "explicit-smoke",
    } as const;
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(await readPersonalizedSourceSmokeConfig(configPath), config);

    const invalid = PersonalizedSourceSmokeConfigSchema.safeParse({
      ...config,
      codex_rollouts: ["relative-rollout.jsonl"],
    });
    assert.equal(invalid.success, false);
    await assert.rejects(
      readPersonalizedSourceSmokeConfig("relative-config.json"),
      (error: unknown) => error instanceof PersonalizedSourceSmokeError && error.code === "config_path_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI source failures are non-zero and never echo explicit private paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-source-smoke-cli-"));
  try {
    const privateRoot = join(root, "private-source-root");
    const configPath = join(root, "smoke.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      codex_rollouts: [join(privateRoot, "missing-rollout.jsonl")],
      obsidian_vault_root: privateRoot,
      obsidian_notes: ["missing-note.md"],
      obsidian_vault_id: "cli-failure-smoke",
    }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "scripts/v1/personalized-source-smoke.ts",
      "--config",
      configPath,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(privateRoot)));
    const lastLine = result.stderr.trim().split("\n").at(-1);
    assert.deepEqual(JSON.parse(lastLine ?? "{}"), {
      ok: false,
      code: "codex_source_unreadable",
      message: "Selected codex source at index 0 could not be copied safely",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

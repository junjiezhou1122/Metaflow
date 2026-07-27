import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "@info/agent-runtime-adapter";
import type { ExactViewRef } from "@info/view";
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
    assert.equal(evidence.version, 3);
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
    assert.equal(evidence.workflow, null);
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

test("the same captured exact Views traverse the full workflow, durable replay, and Privacy Forget", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-full-source-smoke-"));
  const note = join(root, "Projects", "private-note.md");
  const agent = new SyntheticPersonalizedAgent();
  const acceptanceSequence: string[] = [];
  try {
    await mkdir(join(root, "Projects"));
    await writeFile(note, `# Private note\n\n${PRIVATE_MARKER}\n`, { mode: 0o600 });
    const evidence = await runPersonalizedSourceSmoke({
      version: 1,
      codex_rollouts: [resolve("tests/fixtures/codex-history/minimal-session.jsonl")],
      obsidian_vault_root: root,
      obsidian_notes: ["Projects/private-note.md"],
      obsidian_vault_id: "synthetic-personalized-full-smoke",
      workflow: {
        enabled: true,
        external_model_approved: false,
        max_codex_messages: 2,
        internal_query: PRIVATE_MARKER,
      },
    }, {
      now: () => NOW,
      temporary_parent: root,
      agent_runtime: agent,
      local_agent_runtime: true,
      agent_access_gate: async input => {
        await assertGateCanReadExactViews(input.operations, input.principal, input.working_state, input.application_space);
        acceptanceSequence.push("agent-access");
        return {
          contract_version: 2,
          ok: true,
          agent: "claude_acp",
          transport: "mcp",
          skill_sha256: "1".repeat(64),
          citation_sha256: "2".repeat(64),
          citation_count: 2,
          operation_sequence_sha256: "3".repeat(64),
          operation_counts: { search: 2, exact_get: 2, graph_project: 1 },
        };
      },
      graph_explorer_gate: async input => {
        await assertGateCanReadExactViews(input.operations, input.principal, input.working_state, input.application_space);
        acceptanceSequence.push("graph-explorer");
        return {
          contract_version: 1,
          graph_ready: true,
          exact_working_state_selected: true,
          accessible_dom_synchronized: true,
          node_count: 6,
          edge_count: 5,
          canvas_non_background_samples: 120,
          canvas_unique_colors: 8,
          operations: { view_graph_project: 1, view_get: 1, view_search: 0 },
          browser_console_errors: 0,
          browser_console_warnings: 0,
          chromium_webgl_driver_warnings: 0,
          retained_artifacts: false,
        };
      },
    });

    PersonalizedSourceSmokeEvidenceSchema.parse(evidence);
    assert.equal(evidence.version, 3);
    assert.equal(evidence.workflow?.source_count, 3);
    assert.equal(evidence.workflow?.fragment_count, 1);
    assert.ok((evidence.workflow?.graph_node_count ?? 0) >= 3);
    assert.equal(evidence.workflow?.surface_parity, true);
    assert.deepEqual(evidence.workflow?.transformation_revisions, [1, 2]);
    assert.equal(evidence.workflow?.restart_exact_replay, true);
    assert.equal(evidence.workflow?.privacy_forget, true);
    assert.equal(evidence.workflow?.semantic, "not_run_no_authorized_embedding");
    assert.equal(evidence.workflow?.agent_access.transport, "mcp");
    assert.equal(evidence.workflow?.agent_access.citation_count, 2);
    assert.equal(evidence.workflow?.graph_explorer.graph_ready, true);
    assert.equal(evidence.workflow?.graph_explorer.exact_working_state_selected, true);
    assert.equal(evidence.workflow?.graph_explorer.accessible_dom_synchronized, true);
    assert.deepEqual(acceptanceSequence, ["agent-access", "graph-explorer"]);
    assert.match(evidence.workflow?.source_manifest_sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok((evidence.workflow?.search_hit_counts.keyword ?? 0) > 0);
    assert.ok((evidence.workflow?.search_hit_counts.internal ?? 0) > 0);
    assert.ok((evidence.workflow?.search_hit_counts.relation ?? 0) > 0);
    assert.equal(agent.authoringCalls, 1);
    assert.equal(agent.executionCalls, 1, "restart replay must not invoke the Agent Worker twice");

    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(root)));
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

async function assertGateCanReadExactViews(
  operations: { execute(request: unknown, context: unknown): Promise<unknown> },
  principal: { id: string; grants: string[] },
  ...refs: ExactViewRef[]
): Promise<void> {
  for (const [index, ref] of refs.entries()) {
    const envelope = await operations.execute(
      { operation: "view.get", input: { ref } },
      { request_id: `request:synthetic-pre-forget-gate:${index}`, principal },
    ) as { ok?: unknown; data?: { id?: unknown; revision?: unknown } };
    assert.equal(envelope.ok, true, "acceptance gate must run before Privacy Forget");
    assert.equal(envelope.data?.id, ref.view_id);
    assert.equal(envelope.data?.revision, ref.revision);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class SyntheticPersonalizedAgent implements AgentRuntimeAdapter {
  readonly id = "personalized-source-agent";
  readonly kind = "mock" as const;
  authoringCalls = 0;
  executionCalls = 0;

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const], supportsCancel: false };
  }

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    if (task.outputContract.viewType === "metaflow.authoring.transformation.proposal") {
      this.authoringCalls += 1;
      const sourceRefs = ((task.currentContext?.raw?.metaflow_authoring_request as { source_views?: ExactViewRef[] } | undefined)
        ?.source_views ?? []).map(ref => ({ view_id: ref.view_id, revision: ref.revision }));
      assert.equal(sourceRefs.length, 3);
      return { ok: true, reason: "strict synthetic proposal", schemaValue: transformationCandidate(sourceRefs) };
    }
    if (task.outputContract.viewType === "personal.working_state") {
      this.executionCalls += 1;
      const evidence = task.currentContext?.raw?.metaflow_inputs as Array<{ ref: ExactViewRef }> | undefined;
      assert.equal(evidence?.length, 3);
      return {
        ok: true,
        reason: "strict synthetic working state",
        schemaValue: {
          summary: "Personalized Evidence Working State",
          confirmed_decisions: ["The selected exact evidence was processed."],
          open_questions: ["Which confirmed decision should be explored next?"],
          next_actions: ["Inspect the exact Application Space graph."],
          sources: evidence!.map(item => item.ref),
        },
      };
    }
    throw new Error(`Unexpected output View type: ${task.outputContract.viewType}`);
  }
}

function transformationCandidate(sourceRefs: ExactViewRef[]) {
  const exactRefSchema = {
    type: "object",
    required: ["view_id", "revision"],
    additionalProperties: false,
    properties: {
      view_id: { type: "string", minLength: 1, maxLength: 240 },
      revision: { type: "integer", minimum: 1 },
    },
  };
  const accessPolicy = {
    id: "policy:personalized-real-source",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  };
  return {
    kind: "transformation",
    transformation: {
      id: "transformation:personalized-real-source:working-state",
      revision: 1,
      name: "Personalized Evidence Working State",
      instruction: {
        format: "natural_language",
        text: "Synthesize the exact selected evidence into confirmed decisions, open questions, and next actions.",
        parameters: {},
      },
      operator: {
        id: "operator:personalized-real-source:working-state",
        revision: 1,
        reference: { kind: "agent", adapter: "agent-execution", profile: "personalized-working-state" },
        configuration: {
          runtime_override: "personalized-source-agent",
          execution_mode: "invoke",
          output_mode: "schema_value",
          autonomy: "suggest",
          allow_network: false,
          allow_write: false,
        },
        required_capabilities: [],
      },
      inputs: [{
        role: "sources",
        required: true,
        sources: sourceRefs.map(ref => ({ kind: "view", ref })),
      }],
      output: {
        schema: {
          name: "personal.working_state",
          version: 1,
          mode: "strict",
          dialect: "https://json-schema.org/draft/2020-12/schema",
          json_schema: {
            type: "object",
            required: ["summary", "confirmed_decisions", "open_questions", "next_actions", "sources"],
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              confirmed_decisions: { type: "array", items: { type: "string" } },
              open_questions: { type: "array", items: { type: "string" } },
              next_actions: { type: "array", items: { type: "string" } },
              sources: { type: "array", minItems: 1, items: exactRefSchema },
            },
          },
          search_projection: {
            version: 1,
            fields: [
              { path: "/name", category: "title" },
              { path: "/representation/value/summary", category: "text" },
              { path: "/representation/value/confirmed_decisions/*", category: "text" },
              { path: "/representation/value/open_questions/*", category: "text" },
              { path: "/representation/value/next_actions/*", category: "text" },
            ],
          },
        },
        schema_origin: "declared",
        cardinality: { min: 1, max: 1 },
      },
      policy: accessPolicy,
      budget: {
        id: "budget:personalized-real-source:working-state",
        revision: 1,
        limits: { timeout_ms: 120_000, max_attempts: 1, max_input_tokens: 30_000, max_output_tokens: 4_000 },
        extensions: {},
      },
      created_at: NOW,
      metadata: {},
    },
    expected_revision: 0,
    execute: {
      run_id: "run:personalized-real-source:working-state",
      correlation_id: "correlation:personalized-real-source:working-state",
      access_policy: accessPolicy,
      access_use: "local_execution",
      invocation_inputs: [{ role: "sources", views: sourceRefs }],
      idempotency_key: "execution:personalized-real-source:working-state",
    },
  };
}

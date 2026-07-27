import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "@info/agent-runtime-adapter";
import { exactViewRef, parseViewDraft, type ViewDraft } from "@info/view";
import {
  APPLICATION_SPACE_REPRESENTATION_KIND,
  applicationSpaceRelations,
  applicationSpaceSchema,
  normalizeApplicationSpaceEntries,
} from "../view-packages/application-space/index.ts";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import {
  PersonalizedAgentAccessError,
  PersonalizedAgentAccessEvidenceSchema,
  runPersonalizedAgentAccessGate,
} from "../scripts/v1/personalized-agent-access.ts";

const NOW = "2026-07-27T12:00:00.000Z";
const OPERATION_TOKEN = "synthetic-composition-token-at-least-32-bytes";
const POLICY = {
  owner: "user:local",
  visibility: "private" as const,
  privacy: "private" as const,
  retention: "normal" as const,
  allow_external_model: false,
  allow_embedding: false,
  allow_local_search: true,
  labels: ["synthetic-agent-access"],
};

test("independent read-only Codex gate uses the staged skill and returns only content-free citation evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-agent-access-test-"));
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory);
  const fakeCodex = join(root, "codex");
  await copyFile(
    new URL("./fixtures/personalized-agent-access-codex.mjs", import.meta.url),
    fakeCodex,
  );
  await chmod(fakeCodex, 0o755);
  const composition = await createAmbientDaemonComposition({
    data_directory: dataDirectory,
    operation_auth_token: OPERATION_TOKEN,
    agent_runtime: new UnusedAgentRuntime(),
    now: () => new Date(NOW),
  });
  try {
    const workingState = (await composition.views.commit({
      draft: workingStateDraft(),
      expected_revision: 0,
    })).view;
    const entries = normalizeApplicationSpaceEntries([{
      ref: exactViewRef(workingState),
      semantics: "composition",
    }]);
    const applicationSpace = (await composition.views.commit({
      draft: parseViewDraft({
        id: "view:synthetic:agent-access:application-space",
        name: "Synthetic Agent Application Space",
        purpose: "Compose the exact synthetic working-state View for independent Agent access",
        aliases: [],
        schema: applicationSpaceSchema,
        role: "derived",
        time: { created_at: NOW },
        representation: {
          form: "inline",
          kind: APPLICATION_SPACE_REPRESENTATION_KIND,
          media_type: "application/json",
          value: { version: 1, entries },
          metadata: {},
        },
        materialization: {
          primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: applicationSpaceRelations(entries),
        provenance: { inputs: [exactViewRef(workingState)], actor: "user:local" },
        policy: POLICY,
        metadata: {},
      }),
      expected_revision: 0,
    })).view;

    const evidence = await runPersonalizedAgentAccessGate({
      operations: composition.operationService,
      principal: { id: "user:local", grants: ["*"] },
      working_state: exactViewRef(workingState),
      application_space: exactViewRef(applicationSpace),
      queries: {
        working_state: "Synthetic Personalized Evidence Working State",
        application_space: "Synthetic Agent Application Space",
      },
      codex: {
        executable: fakeCodex,
        home: join(root, "unused-codex-home"),
        timeout_ms: 30_000,
      },
      temporary_parent: root,
    });

    assert.deepEqual(PersonalizedAgentAccessEvidenceSchema.parse(evidence), evidence);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.agent, "codex_exec");
    assert.equal(evidence.transport, "http_cli");
    assert.equal(evidence.citation_count, 2);
    assert.equal(evidence.operation_counts.search, 2);
    assert.equal(evidence.operation_counts.exact_get, 2);
    assert.equal(evidence.operation_counts.graph_project, 1);
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      workingState.id,
      applicationSpace.id,
      workingState.name,
      applicationSpace.name,
      root,
      OPERATION_TOKEN,
      "Synthetic working-state content must never enter public gate evidence",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }

    await assert.rejects(
      runPersonalizedAgentAccessGate({
        operations: composition.operationService,
        principal: { id: "user:local", grants: ["*"] },
        working_state: exactViewRef(workingState),
        application_space: exactViewRef(applicationSpace),
        queries: {
          working_state: "Synthetic Personalized Evidence Working State",
          application_space: "Synthetic Agent Application Space",
        },
        codex: {
          executable: join(root, "missing-explicit-codex"),
          home: join(root, "unused-codex-home"),
          timeout_ms: 30_000,
        },
        temporary_parent: root,
      }),
      (error: unknown) => error instanceof PersonalizedAgentAccessError
        && error.code === "codex_executable_invalid",
    );
  } finally {
    await composition.close();
    await rm(root, { recursive: true, force: true });
  }
});

function workingStateDraft(): ViewDraft {
  return parseViewDraft({
    id: "view:synthetic:agent-access:working-state",
    name: "Synthetic Personalized Evidence Working State",
    purpose: "Provide one exact synthetic result for independent Agent access",
    aliases: [],
    schema: {
      name: "personal.working_state",
      version: 1,
      mode: "freeform",
      search_projection: {
        version: 1,
        fields: [{ path: "/name", category: "title" }],
      },
    },
    role: "derived",
    time: { created_at: NOW },
    representation: {
      form: "inline",
      kind: "synthetic_working_state",
      media_type: "application/json",
      value: { private_content: "Synthetic working-state content must never enter public gate evidence" },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: { inputs: [], actor: "user:local" },
    policy: POLICY,
    metadata: {},
  });
}

class UnusedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "unused-agent-access-runtime";
  readonly kind = "mock" as const;

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(_task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    throw new Error("Personalized Agent access must use an independent Codex process");
  }
}

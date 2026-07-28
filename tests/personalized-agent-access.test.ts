import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "@info/agent-runtime-adapter";
import {
  OperationRequestSchema,
  type OperationName,
  type OperationService,
} from "@info/operations";
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

test("independent read-only Claude ACP gate uses the staged skill and returns only content-free citation evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-agent-access-test-"));
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory);
  const fakeClaudeAcp = fileURLToPath(new URL("./fixtures/personalized-agent-access-claude-acp.mjs", import.meta.url));
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
      claude: {
        command: process.execPath,
        args: [fakeClaudeAcp],
        timeout_ms: 30_000,
      },
      temporary_parent: root,
    });

    assert.deepEqual(PersonalizedAgentAccessEvidenceSchema.parse(evidence), evidence);
    assert.equal(evidence.contract_version, 2);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.agent, "claude_acp");
    assert.equal(evidence.transport, "mcp");
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
        claude: {
          args: [fakeClaudeAcp],
          timeout_ms: 30_000,
        },
        temporary_parent: root,
      }),
      (error: unknown) => error instanceof PersonalizedAgentAccessError
        && error.code === "claude_acp_configuration_invalid",
    );

    const executed: Array<{ operation: OperationName; input: unknown }> = [];
    await assert.rejects(
      runPersonalizedAgentAccessGate({
        operations: observeExecutedOperations(composition.operationService, executed),
        principal: { id: "user:local", grants: ["*"] },
        working_state: exactViewRef(workingState),
        application_space: exactViewRef(applicationSpace),
        queries: {
          working_state: "Synthetic Personalized Evidence Working State",
          application_space: "Synthetic Agent Application Space",
        },
        claude: {
          command: process.execPath,
          args: [fakeClaudeAcp, "adversarial"],
          timeout_ms: 30_000,
        },
        temporary_parent: root,
      }),
      (error: unknown) => error instanceof PersonalizedAgentAccessError
        && error.code === "agent_operation_denied",
    );
    const nonCatalog = executed.filter(call => call.operation !== "catalog.list");
    assert.deepEqual(nonCatalog.map(call => call.operation), [
      "view.search",
      "view.get",
      "view.search",
      "view.get",
      "view.graph.project",
    ]);
    assert.deepEqual(
      nonCatalog.filter(call => call.operation === "view.get").map(call => call.input),
      [{ ref: exactViewRef(workingState) }, { ref: exactViewRef(applicationSpace) }],
    );
    assert.deepEqual(
      nonCatalog.filter(call => call.operation === "view.search").map(searchQuery),
      ["Synthetic Personalized Evidence Working State", "Synthetic Agent Application Space"],
    );
    assert.deepEqual(
      nonCatalog.filter(call => call.operation === "view.graph.project").map(graphRoot),
      [exactViewRef(applicationSpace)],
    );

    const timeoutStartedAt = Date.now();
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
        claude: {
          command: process.execPath,
          args: [fakeClaudeAcp, "ignore-sigterm"],
          timeout_ms: 10_000,
        },
        temporary_parent: root,
      }),
      (error: unknown) => error instanceof PersonalizedAgentAccessError
        && error.code === "claude_acp_timeout",
    );
    assert.ok(Date.now() - timeoutStartedAt < 15_000, "signal-ignoring Claude ACP must be hard-killed within the bounded grace period");

    const overflowStartedAt = Date.now();
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
        claude: {
          command: process.execPath,
          args: [fakeClaudeAcp, "output-overflow"],
          timeout_ms: 30_000,
        },
        temporary_parent: root,
      }),
      (error: unknown) => error instanceof PersonalizedAgentAccessError
        && error.code === "claude_acp_output_limit",
    );
    assert.ok(Date.now() - overflowStartedAt < 5_000, "output-overflow Claude ACP must be terminated within the bounded grace period");
    assert.deepEqual(
      (await readdir(root)).filter(name => name.startsWith("metaflow-personalized-agent-access-")),
      [],
    );
  } finally {
    await composition.close();
    await rm(root, { recursive: true, force: true });
  }
});

function observeExecutedOperations(
  service: OperationService,
  executed: Array<{ operation: OperationName; input: unknown }>,
): OperationService {
  const execute = service.execute.bind(service);
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property !== "execute") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (requestInput: unknown, contextInput: unknown) => {
        const request = OperationRequestSchema.parse(requestInput);
        executed.push({ operation: request.operation, input: request.input });
        return execute(requestInput, contextInput);
      };
    },
  });
}

function searchQuery(call: { input: unknown }): unknown {
  const input = call.input as { request?: { query?: { text?: unknown } } };
  return input.request?.query?.text;
}

function graphRoot(call: { input: unknown }): unknown {
  const input = call.input as { request?: { roots?: unknown[] } };
  return input.request?.roots?.[0];
}

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
    throw new Error("Personalized Agent access must use an independent Claude ACP process");
  }
}

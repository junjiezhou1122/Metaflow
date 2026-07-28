import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { OperationEnvelopeSchema, OPERATION_NAMES } from "@info/operations";
import { exactViewRef, parseViewDraft, type ViewDraft } from "@info/view";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import {
  METAFLOW_AMBIENT_SERVER_NAME,
  METAFLOW_AMBIENT_SERVER_VERSION,
  METAFLOW_HTTP_PROTOCOL_NAME,
  METAFLOW_HTTP_PROTOCOL_VERSION,
  OPERATION_EXIT_CODE_BY_CATEGORY,
  OPERATION_HTTP_STATUS_BY_CATEGORY,
  METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  METAFLOW_OPERATION_CATALOG_VERSION,
  doctorAuthenticationProof,
} from "@info/operation-surfaces";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "../packages/adapters/agent-runtime/types.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPackage = join(repositoryRoot, "apps", "mf-cli");
const agentFixture = join(repositoryRoot, "tests", "fixtures", "metaflow-view-access-agent.mjs");
const pluginRoot = join(repositoryRoot, "plugins", "metaflow-view-access");
const skillPath = join(pluginRoot, "skills", "metaflow-view-access", "SKILL.md");
const edgeType = "agent_context";
const now = "2026-07-27T06:00:00.000Z";
const operationAuthToken = "test-operation-auth-token-32-bytes";

test("installed mf, real daemon MCP, and the canonical skill preserve exact authorized View access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-agent-view-access-"));
  const dataDirectory = join(directory, "data");
  mkdirSync(dataDirectory);
  const composition = await createAmbientDaemonComposition({
    data_directory: dataDirectory,
    operation_auth_token: operationAuthToken,
    agent_runtime: new UnusedAgentRuntime(),
    now: () => new Date(now),
  });
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    requests.push({ method: request.method ?? "GET", path });
    if (path === "/mcp") {
      void composition.mcpHandler(request, response);
      return;
    }
    void composition.handler(request, response);
  });

  try {
    const denied = (await composition.views.commit({
      draft: viewDraft("view:agent:denied", "Denied relation must not leak", [], "user:other"),
      expected_revision: 0,
    })).view;
    const neighbor = (await composition.views.commit({
      draft: viewDraft("view:agent:context", "Agent related context", []),
      expected_revision: 0,
    })).view;
    const root = (await composition.views.commit({
      draft: viewDraft("view:agent:evidence", "Agent exact evidence root", [{
        type: edgeType,
        target: exactViewRef(neighbor),
      }, {
        type: edgeType,
        target: exactViewRef(denied),
      }]),
      expected_revision: 0,
    })).view;
    const personalizedRoot = (await composition.views.commit({
      draft: viewDraft("view:fixture:agent-access:personalized-working-state", "Metaflow Implementation Working State", [{
        type: edgeType,
        target: exactViewRef(neighbor),
      }, {
        type: edgeType,
        target: exactViewRef(denied),
      }]),
      expected_revision: 0,
    })).view;
    assert.notEqual(personalizedRoot.id, "view:personalized:working-state");
    const port = await listen(server);
    const daemonUrl = `http://127.0.0.1:${port}`;
    const installedMf = installCli(directory);
    const isolatedCwd = join(directory, "isolated-agent-cwd");
    mkdirSync(isolatedCwd);

    const doctor = await runMf(installedMf, isolatedCwd, daemonUrl, ["--json", "doctor"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(doctor.lines.length, 1);
    assert.equal(doctor.envelope.ok, true);
    assert.equal(doctor.envelope.command, "doctor");
    assert.equal(doctor.envelope.data.daemon.protocol.version, 1);
    assert.equal(doctor.envelope.data.authentication.client_source, "METAFLOW_AUTH_TOKEN");
    assert.equal(doctor.envelope.data.daemon.authentication.proof, undefined);
    assert.equal(doctor.envelope.data.daemon.authentication.challenge, undefined);

    const help = await runMf(installedMf, isolatedCwd, daemonUrl, ["--json", "view.search", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.envelope.data.name, "view.search");
    assert.equal(help.envelope.data.effect, "read");
    assert.deepEqual(help.envelope.data.input_example.request.page, { limit: 20 });
    assert.equal(help.envelope.data.input_schema.type, "object");

    const secret = "must-not-reach-stderr";
    const malformed = await runMf(installedMf, isolatedCwd, daemonUrl, [
      "--json",
      "view.get",
      "--input",
      `{"ref":"${secret}`,
    ]);
    assert.equal(malformed.status, 2);
    assert.equal(malformed.envelope.error.code, "cli_input_invalid");
    assert.equal(malformed.stdout.includes(secret), false);
    assert.equal(malformed.stderr.includes(secret), false);
    assert.equal(requests.some(request => request.path.includes(secret)), false);

    const inputPath = join(isolatedCwd, "exact.json");
    writeFileSync(inputPath, JSON.stringify({ ref: exactViewRef(root) }));
    const fileRead = await runMf(installedMf, isolatedCwd, daemonUrl, ["--json", "view.get", "--input", "@exact.json"]);
    assert.equal(fileRead.status, 0, fileRead.stderr);
    assert.equal(fileRead.envelope.data.id, root.id);
    assert.equal(fileRead.envelope.data.revision, root.revision);

    const missing = await runMf(installedMf, isolatedCwd, daemonUrl, [
      "--json",
      "view.get",
      "--input",
      JSON.stringify({ ref: { view_id: "view:agent:missing", revision: 1 } }),
    ]);
    assert.equal(missing.status, 4);
    assert.equal(missing.envelope.error.code, "view_not_found");

    const agentRequestStart = requests.length;
    const agentProcess = await runProcess(process.execPath, [agentFixture], {
      cwd: isolatedCwd,
      env: {
        ...process.env,
        METAFLOW_DAEMON_URL: daemonUrl,
        MF_BIN: installedMf,
        MF_SKILL: skillPath,
        MF_EDGE_TYPE: edgeType,
        METAFLOW_AUTH_TOKEN: operationAuthToken,
      },
    });
    assert.equal(agentProcess.status, 0, agentProcess.stderr);
    const agentOutput = JSON.parse(agentProcess.stdout);
    assert.equal(agentOutput.selected_ref_source, "view.search.hit.ref");
    assert.equal(agentOutput.citation, `${root.id}@${root.revision}`);
    assert.deepEqual(agentOutput.graph_citations, [
      `${neighbor.id}@${neighbor.revision}`,
      `${root.id}@${root.revision}`,
    ].sort());
    assert.deepEqual(agentOutput.truncation, { truncated: true, reasons: ["depth_limit"] });
    assert.equal(agentOutput.redacted_boundary, true);
    assert.equal(agentProcess.stdout.includes(denied.id), false);
    assert.equal(agentProcess.stdout.includes(denied.name), false);
    assert.deepEqual(requests.slice(agentRequestStart).map(request => [request.method, request.path]), [
      ["GET", "/metaflow/v1/doctor"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/catalog.list"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/view.search"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/view.get"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/view.graph.project"],
    ]);

    const overrideRequestStart = requests.length;
    const overrideAgentProcess = await runProcess(process.execPath, [agentFixture], {
      cwd: isolatedCwd,
      env: {
        ...process.env,
        METAFLOW_DAEMON_URL: daemonUrl,
        MF_BIN: installedMf,
        MF_SKILL: skillPath,
        MF_EDGE_TYPE: edgeType,
        MF_QUERY: "Metaflow Implementation Working State",
        METAFLOW_AUTH_TOKEN: operationAuthToken,
      },
    });
    assert.equal(overrideAgentProcess.status, 0, overrideAgentProcess.stderr);
    const overrideAgentOutput = JSON.parse(overrideAgentProcess.stdout);
    assert.equal(overrideAgentOutput.selected_ref_source, "view.search.hit.ref");
    assert.equal(overrideAgentOutput.citation, `${personalizedRoot.id}@${personalizedRoot.revision}`);
    assert.deepEqual(overrideAgentOutput.graph_citations, [
      `${neighbor.id}@${neighbor.revision}`,
      `${personalizedRoot.id}@${personalizedRoot.revision}`,
    ].sort());
    assert.equal(overrideAgentProcess.stdout.includes(root.id), false);
    assert.equal(overrideAgentProcess.stdout.includes(denied.id), false);
    assert.deepEqual(requests.slice(overrideRequestStart).map(request => [request.method, request.path]), [
      ["GET", "/metaflow/v1/doctor"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/catalog.list"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/view.search"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/view.get"],
      ["GET", "/metaflow/v1/doctor"],
      ["POST", "/metaflow/v1/operations/view.graph.project"],
    ]);

    const rejectedRequestStart = requests.length;
    const rejectedAgentProcess = await runProcess(process.execPath, [agentFixture], {
      cwd: isolatedCwd,
      env: {
        ...process.env,
        METAFLOW_DAEMON_URL: daemonUrl,
        MF_BIN: installedMf,
        MF_SKILL: skillPath,
        MF_EDGE_TYPE: edgeType,
        MF_QUERY: "   ",
        METAFLOW_AUTH_TOKEN: operationAuthToken,
      },
    });
    assert.notEqual(rejectedAgentProcess.status, 0);
    assert.match(rejectedAgentProcess.stderr, /MF_QUERY must be non-empty when provided/u);
    assert.equal(requests.length, rejectedRequestStart);

    const client = new Client({ name: "metaflow-view-access-conformance", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${operationAuthToken}` } },
    }));
    try {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, OPERATION_NAMES.length);
      assert.ok(listed.tools.every(tool => tool.outputSchema?.type === "object"));
      assert.ok(listed.tools.every(tool => Array.isArray((tool.outputSchema as { oneOf?: unknown[] }).oneOf)));
      assert.ok(listed.tools.every(tool => (tool.outputSchema as { oneOf: unknown[] }).oneOf.length === 2));
      const viewGet = listed.tools.find(tool => tool.name === "metaflow_view_get")!;
      assert.equal(viewGet.annotations?.readOnlyHint, true);
      assert.equal(viewGet.annotations?.destructiveHint, false);
      const forget = listed.tools.find(tool => tool.name === "metaflow_privacy_forget_execute")!;
      assert.equal(forget.annotations?.readOnlyHint, false);
      assert.equal(forget.annotations?.destructiveHint, true);

      const result = await client.callTool({
        name: "metaflow_view_get",
        arguments: { ref: exactViewRef(root) },
      });
      const envelope = OperationEnvelopeSchema.parse(result.structuredContent);
      assert.equal(envelope.ok, true);
      assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), envelope);
    } finally {
      await client.close();
    }

    assert.deepEqual(
      new Set(requests.filter(request => request.path.startsWith("/metaflow/v1/operations/")).map(request => request.path)),
      new Set([
        "/metaflow/v1/operations/catalog.list",
        "/metaflow/v1/operations/view.search",
        "/metaflow/v1/operations/view.get",
        "/metaflow/v1/operations/view.graph.project",
      ]),
    );
    assert.equal(requests.some(request => /sqlite|latest/iu.test(request.path)), false);
  } finally {
    await closeServer(server);
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the skill-only plugin has one canonical validated skill body and no runtime payload", () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["description", "keywords", "name", "repository", "skills", "version"]);
  assert.equal(manifest.skills, "./skills/");
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /view_id@revision/u);
  assert.match(skill, /untrusted evidence/u);
  assert.match(skill, /Never open Metaflow SQLite/u);
  assert.match(skill, /Never guess a latest revision/u);
  assert.equal(skill.includes("METAFLOW_AUTH_TOKEN"), false);
  assert.equal(skill.includes("data/ambient-v1"), false);
});

test("the generated installable CLI wire contract cannot drift from the shared adapter contract", async () => {
  const { mfWireBuildPaths } = await import("../scripts/v1/build-mf-wire.mjs") as {
    mfWireBuildPaths(moduleUrl: string): { absWorkingDir: string; outfile: string };
  };
  const escapedModuleUrl = pathToFileURL(join(tmpdir(), "metaflow repo with spaces", "scripts", "v1", "build-mf-wire.mjs")).href;
  const escapedPaths = mfWireBuildPaths(escapedModuleUrl);
  assert.equal(escapedPaths.absWorkingDir, join(tmpdir(), "metaflow repo with spaces"));
  assert.equal(escapedPaths.outfile, join(tmpdir(), "metaflow repo with spaces", "apps", "mf-cli", "bin", "wire.mjs"));
  assert.equal(escapedPaths.outfile.includes("%20"), false);

  const { MF_WIRE_CONTRACT } = await import("../apps/mf-cli/bin/mf.mjs") as {
    MF_WIRE_CONTRACT: {
      protocol: unknown;
      server: unknown;
      endpoints: unknown;
      operations: unknown;
      http_status_by_category: unknown;
      exit_code_by_category: unknown;
    };
  };
  assert.deepEqual(MF_WIRE_CONTRACT.protocol, {
    name: METAFLOW_HTTP_PROTOCOL_NAME,
    version: METAFLOW_HTTP_PROTOCOL_VERSION,
  });
  assert.deepEqual(MF_WIRE_CONTRACT.server, {
    name: METAFLOW_AMBIENT_SERVER_NAME,
    version: METAFLOW_AMBIENT_SERVER_VERSION,
  });
  assert.deepEqual(MF_WIRE_CONTRACT.endpoints, {
    operations: "/metaflow/v1/operations/",
    mcp: "/mcp",
  });
  assert.deepEqual(MF_WIRE_CONTRACT.operations, OPERATION_NAMES);
  assert.deepEqual(MF_WIRE_CONTRACT.http_status_by_category, OPERATION_HTTP_STATUS_BY_CATEGORY);
  assert.deepEqual(MF_WIRE_CONTRACT.exit_code_by_category, OPERATION_EXIT_CODE_BY_CATEGORY);

  const wireOutput = join(repositoryRoot, "apps", "mf-cli", "bin", "wire.mjs");
  const generated = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ["packages/adapters/operation-surfaces/wire-contract.ts"],
    outfile: wireOutput,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    write: false,
  });
  assert.equal(generated.outputFiles.length, 1);
  assert.equal(Buffer.from(generated.outputFiles[0]!.contents).equals(readFileSync(wireOutput)), true);
});

test("mf doctor fails closed on protocol, authentication, and credential-bearing URL configuration", async () => {
  const { runMfCli } = await import("../apps/mf-cli/bin/mf.mjs") as {
    runMfCli(argv: string[], options: { env: NodeJS.ProcessEnv; fetch: typeof fetch }): Promise<{
      exit_code: number;
      stdout: string;
      stderr: string;
      envelope: { error?: { code?: string } };
    }>;
  };
  const doctorBody = {
    ok: true,
    protocol: { name: "metaflow-operations-http", version: 1 },
    server: { name: "ambient-daemon", version: "0.1.0", origin: "http://127.0.0.1:3111" },
    authentication: {
      source: "METAFLOW_AUTH_TOKEN",
      required: true,
      scheme: "Bearer",
      challenge_scheme: "HMAC-SHA256",
      challenge: "0".repeat(64),
      proof: doctorAuthenticationProof(operationAuthToken, "0".repeat(64), "http://127.0.0.1:3111"),
    },
    catalog: {
      version: METAFLOW_OPERATION_CATALOG_VERSION,
      fingerprint: METAFLOW_OPERATION_CATALOG_FINGERPRINT,
      operations: OPERATION_NAMES,
    },
    endpoints: { operations: "/metaflow/v1/operations/", mcp: "/mcp" },
  };
  const doctorForInput = (input: RequestInfo | URL, token = operationAuthToken) => {
    const url = new URL(String(input));
    const challenge = url.searchParams.get("challenge") ?? "";
    return {
      ...doctorBody,
      server: { ...doctorBody.server, origin: url.origin },
      authentication: {
        ...doctorBody.authentication,
        challenge,
        proof: doctorAuthenticationProof(token, challenge, url.origin),
      },
    };
  };
  const doctorHeaders = { "x-metaflow-protocol-version": "1" };
  const mismatch = await runMfCli(["--json", "doctor"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111" },
    fetch: async input => new Response(JSON.stringify({
      ...doctorForInput(input),
      protocol: { ...doctorBody.protocol, version: 2 },
    }), { status: 200, headers: doctorHeaders }),
  });
  assert.equal(mismatch.exit_code, 6);
  assert.equal(mismatch.envelope.error?.code, "daemon_protocol_mismatch");

  for (const [server, code] of [
    [{ ...doctorBody.server, name: "not-metaflow" }, "daemon_server_mismatch"],
    [{ ...doctorBody.server, version: "0.2.0" }, "daemon_version_mismatch"],
  ] as const) {
    const incompatible = await runMfCli(["--json", "doctor"], {
      env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111" },
      fetch: async input => new Response(JSON.stringify({ ...doctorForInput(input), server }), { status: 200, headers: doctorHeaders }),
    });
    assert.equal(incompatible.exit_code, 6);
    assert.equal(incompatible.envelope.error?.code, code);
  }

  let authRequiredRequests = 0;
  const authRequired = await runMfCli(["--json", "doctor"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111" },
    fetch: async input => {
      authRequiredRequests += 1;
      return new Response(JSON.stringify({
        ...doctorForInput(input),
      }), { status: 200, headers: doctorHeaders });
    },
  });
  assert.equal(authRequired.exit_code, 3);
  assert.equal(authRequired.envelope.error?.code, "daemon_auth_required");
  assert.equal(authRequiredRequests, 1);

  let request = 0;
  const authorizations: Array<string | null> = [];
  const authToken = "do-not-print-this-token-at-least-32-bytes";
  const auth = await runMfCli(["--json", "doctor"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111", METAFLOW_AUTH_TOKEN: authToken },
    fetch: async (input, init) => {
      request += 1;
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (request <= 2) return new Response(JSON.stringify({
        ...doctorForInput(input, authToken),
      }), { status: 200, headers: doctorHeaders });
      return new Response(JSON.stringify({
        ok: false,
        request_id: "request:test:auth",
        operation: "catalog.list",
        error: { code: "operation_forbidden", message: "Forbidden", category: "forbidden", details: {} },
      }), { status: 403, headers: { "x-metaflow-protocol-version": "1" } });
    },
  });
  assert.equal(auth.exit_code, 3);
  assert.equal(auth.envelope.error?.code, "operation_forbidden");
  assert.deepEqual(authorizations, [null, null, `Bearer ${authToken}`]);
  assert.equal(auth.stdout.includes(authToken), false);
  assert.equal(auth.stderr.includes(authToken), false);

  const replacedListenerAuthorizations: Array<string | null> = [];
  let replacedListenerRequests = 0;
  const replacedListener = await runMfCli(["--json", "doctor"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111", METAFLOW_AUTH_TOKEN: authToken },
    fetch: async (input, init) => {
      replacedListenerRequests += 1;
      replacedListenerAuthorizations.push(new Headers(init?.headers).get("authorization"));
      if (replacedListenerRequests === 1) {
        return new Response(JSON.stringify(doctorForInput(input, authToken)), { status: 200, headers: doctorHeaders });
      }
      return new Response(JSON.stringify(doctorForInput(input, "listener-replaced-with-an-exact-mimic")), {
        status: 200,
        headers: doctorHeaders,
      });
    },
  });
  assert.equal(replacedListener.exit_code, 3);
  assert.equal(replacedListener.envelope.error?.code, "daemon_credential_mismatch");
  assert.equal(replacedListenerRequests, 2);
  assert.deepEqual(replacedListenerAuthorizations, [null, null]);
  assert.equal(replacedListener.stdout.includes(authToken), false);
  assert.equal(replacedListener.stderr.includes(authToken), false);

  const configuredSecret = await runMfCli(["--json", "doctor"], {
    env: { METAFLOW_DAEMON_URL: "http://user:password@127.0.0.1:3111" },
    fetch: async () => { throw new Error("fetch must not run"); },
  });
  assert.equal(configuredSecret.exit_code, 2);
  assert.equal(configuredSecret.envelope.error?.code, "daemon_url_invalid");
  assert.equal(configuredSecret.stdout.includes("password"), false);
  assert.equal(configuredSecret.stderr.includes("password"), false);

  let unknownRequest = 0;
  const unknown = await runMfCli(["--json", "typo.operation"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111" },
    fetch: async () => {
      unknownRequest += 1;
      throw new Error("unknown Operation must be rejected before fetch");
    },
  });
  assert.equal(unknown.exit_code, 2);
  assert.equal(unknown.envelope.error?.code, "operation_unknown");
  assert.equal((unknown.envelope as { operation?: unknown }).operation, undefined);
  OperationEnvelopeSchema.parse(unknown.envelope);
  assert.equal(unknownRequest, 0);

  const leakedAuthorizations: Array<string | null> = [];
  const authNotRequired = await runMfCli(["--json", "catalog.list"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111", METAFLOW_AUTH_TOKEN: operationAuthToken },
    fetch: async (input, init) => {
      leakedAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({
        ...doctorForInput(input),
        authentication: { ...doctorForInput(input).authentication, required: false },
      }), { status: 200, headers: doctorHeaders });
    },
  });
  assert.equal(authNotRequired.exit_code, 6);
  assert.equal(authNotRequired.envelope.error?.code, "daemon_auth_contract_mismatch");
  assert.deepEqual(leakedAuthorizations, [null]);

  let emptyRequestIdCall = 0;
  const emptyRequestId = await runMfCli(["--json", "catalog.list"], {
    env: { METAFLOW_DAEMON_URL: "http://127.0.0.1:3111", METAFLOW_AUTH_TOKEN: operationAuthToken },
    fetch: async input => {
      emptyRequestIdCall += 1;
      if (emptyRequestIdCall === 1) return new Response(JSON.stringify(doctorForInput(input)), { status: 200, headers: doctorHeaders });
      return new Response(JSON.stringify({ ok: true, request_id: "", operation: "catalog.list", data: [] }), {
        status: 200,
        headers: doctorHeaders,
      });
    },
  });
  assert.equal(emptyRequestId.exit_code, 6);
  assert.equal(emptyRequestId.envelope.error?.code, "daemon_envelope_invalid");
});

function installCli(directory: string): string {
  const packageDirectory = join(directory, "cli-package");
  const installDirectory = join(directory, "cli-install");
  mkdirSync(packageDirectory);
  mkdirSync(installDirectory);
  writeFileSync(join(installDirectory, "package.json"), JSON.stringify({ private: true }));
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", packageDirectory], {
    cwd: cliPackage,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const archive = join(packageDirectory, JSON.parse(packed.stdout)[0].filename);
  const installed = spawnSync("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    archive,
  ], { cwd: installDirectory, encoding: "utf8" });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  return join(installDirectory, "node_modules", ".bin", "mf");
}

async function runMf(binary: string, cwd: string, daemonUrl: string, args: string[]) {
  const result = await runProcess(binary, args, {
    cwd,
    env: { ...process.env, METAFLOW_DAEMON_URL: daemonUrl, METAFLOW_AUTH_TOKEN: operationAuthToken },
  });
  const lines = result.stdout.trim().split("\n");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lines,
    envelope: JSON.parse(lines[0]!),
  };
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

function viewDraft(
  id: string,
  name: string,
  relations: ViewDraft["relations"],
  owner = "user:local",
): ViewDraft {
  return parseViewDraft({
    id,
    name,
    purpose: "Prove isolated Agent access through exact daemon Operations",
    aliases: [],
    schema: {
      name: "agent.access.fixture",
      version: 1,
      mode: "freeform",
      search_projection: { version: 1, fields: [{ path: "/name", category: "title" }] },
    },
    role: "derived",
    time: { created_at: now },
    representation: {
      form: "inline",
      kind: "agent_access_fixture",
      media_type: "application/json",
      value: { evidence: name },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations,
    provenance: { inputs: [], actor: owner },
    policy: {
      owner,
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      allow_local_search: true,
      labels: [],
    },
    metadata: {},
  });
}

class UnusedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "acp_stdio";
  readonly kind = "acp_stdio" as const;

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      modes: ["invoke" as const],
      supportsDryRun: false,
      supportsCancel: false,
      supportsPermissionRequests: false,
      supportsProgress: false,
      supportsMcpServers: true,
    };
  }

  async submit(_task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    throw new Error("Agent runtime must not be invoked by View access conformance");
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent access daemon did not bind a TCP port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

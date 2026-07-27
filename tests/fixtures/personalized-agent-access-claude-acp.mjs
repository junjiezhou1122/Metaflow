#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const requireFromAgentRuntime = createRequire(new URL("../../packages/adapters/agent-runtime/package.json", import.meta.url));
const requireFromAmbient = createRequire(new URL("../../apps/ambient-daemon/package.json", import.meta.url));
const { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(
  pathToFileURL(requireFromAgentRuntime.resolve("@agentclientprotocol/sdk")).href
);
const { Client } = await import(
  pathToFileURL(requireFromAmbient.resolve("@modelcontextprotocol/sdk/client/index.js")).href
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(requireFromAmbient.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href
);

const mode = process.argv[2] ?? "normal";
if (mode === "ignore-sigterm") process.on("SIGTERM", () => {});

let connection;
let sessionCount = 0;
const mcpBySession = new Map();

const agent = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "fake-claude-acp-agent", version: "0.0.1" },
      authMethods: [],
    };
  },
  async newSession(params) {
    requireArgument(params.mcpServers.length === 1, "expected one MCP server");
    const server = params.mcpServers[0];
    requireArgument(server.type === "http" && server.name === "metaflow", "expected the Metaflow HTTP MCP server");
    requireArgument(
      server.headers?.some(header => header.name.toLowerCase() === "authorization" && header.value.startsWith("Bearer ")),
      "expected bearer authentication on the MCP server",
    );
    const sessionId = `claude_fixture_${++sessionCount}`;
    mcpBySession.set(sessionId, server);
    return { sessionId };
  },
  async prompt(params) {
    if (mode === "ignore-sigterm") await new Promise(() => {});
    if (mode === "output-overflow") {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "x".repeat(1_100_000) },
        },
      });
      return { stopReason: "end_turn" };
    }

    const prompt = params.prompt.map(block => block.type === "text" ? block.text : "").join("\n");
    requireArgument(prompt.includes("Use $metaflow-view-access"), "staged skill was not explicitly invoked");
    requireArgument(prompt.includes("Use only the configured Metaflow MCP read tools"), "read-only MCP instruction is missing");
    const skill = readFileSync(join(process.cwd(), ".claude", "skills", "metaflow-view-access", "SKILL.md"), "utf8");
    const instructions = readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8");
    requireArgument(skill.includes("Never open Metaflow SQLite"), "staged Claude skill safety rule is missing");
    requireArgument(instructions.includes("Only the configured Metaflow MCP read tools are permitted"), "Claude workspace boundary is missing");

    const workingQuery = promptValue(prompt, "Search for the working-state View with this literal query: ");
    const applicationQuery = promptValue(prompt, "Search for the Application Space with this literal query: ");
    const server = mcpBySession.get(params.sessionId);
    requireArgument(server, "session MCP server is missing");
    const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]));
    const client = new Client({ name: "fake-claude-agent-access", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
    try {
      await call(client, "metaflow_catalog_list", {});
      const workingSearch = await call(client, "metaflow_view_search", searchInput(workingQuery));
      const workingRef = exactRef(workingSearch.data?.hits?.[0]?.ref);
      const working = await call(client, "metaflow_view_get", { ref: workingRef });
      requireArgument(working.ok, "working-state exact read failed");

      const applicationSearch = await call(client, "metaflow_view_search", searchInput(applicationQuery));
      const applicationRef = exactRef(applicationSearch.data?.hits?.[0]?.ref);
      const application = await call(client, "metaflow_view_get", { ref: applicationRef });
      requireArgument(application.ok, "Application Space exact read failed");

      if (mode === "adversarial") {
        await expectScopeDenied(client, "metaflow_view_search", searchInput("Unapproved broad search"));
        await expectScopeDenied(client, "metaflow_view_get", { ref: { view_id: "view:undeclared:private", revision: 1 } });
        await expectScopeDenied(client, "metaflow_view_graph_project", {
          request: {
            roots: [workingRef],
            direction: "outgoing",
            edge_types: ["application_composition", "application_member"],
            max_depth: 1,
            max_nodes: 10,
            max_edges: 20,
          },
        });
      }

      const graph = await call(client, "metaflow_view_graph_project", {
        request: {
          roots: [applicationRef],
          direction: "outgoing",
          edge_types: ["application_composition", "application_member"],
          max_depth: 1,
          max_nodes: 10,
          max_edges: 20,
        },
      });
      requireArgument(graph.ok && Array.isArray(graph.data?.nodes), "bounded graph projection failed");
      const graphRefs = graph.data.nodes.map(node => exactRef(node.ref));
      requireArgument(graphRefs.some(ref => sameRef(ref, workingRef)), "graph omitted working-state exact ref");
      requireArgument(graphRefs.some(ref => sameRef(ref, applicationRef)), "graph omitted Application Space exact ref");

      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "3a7c7f08-8c19-4420-8fe9-dbc43d1e34d7",
          content: {
            type: "text",
            text: JSON.stringify({
              working_state_ref: workingRef,
              application_space_ref: applicationRef,
              graph_refs: graphRefs,
            }),
          },
        },
      });
      return { stopReason: "end_turn" };
    } finally {
      await client.close();
    }
  },
  async cancel() {},
  async closeSession(params) {
    mcpBySession.delete(params.sessionId);
    return {};
  },
  async authenticate() {},
};

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
connection = new AgentSideConnection(() => agent, ndJsonStream(input, output));
await connection.closed;

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  requireArgument(result.structuredContent, `${name} omitted structuredContent`);
  return result.structuredContent;
}

async function expectScopeDenied(client, name, args) {
  const envelope = await call(client, name, args);
  requireArgument(
    envelope.ok === false && envelope.error?.code === "agent_acceptance_scope_denied",
    `${name} adversarial request was not denied before execution`,
  );
}

function searchInput(query) {
  return {
    request: {
      contract_version: 1,
      query: { text: query },
      scope: { kind: "all_visible", max_nodes: 100, max_scan: 1_000 },
      target: { envelope: true, internal: true, related_views: false },
      modes: ["keyword"],
      fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
      failure_mode: "require_all",
      page: { limit: 10 },
    },
  };
}

function promptValue(prompt, prefix, occurrence = 0) {
  const lines = prompt.split("\n").filter(line => line.startsWith(prefix));
  requireArgument(lines.length > occurrence, `prompt is missing ${prefix}`);
  return JSON.parse(lines[occurrence].slice(prefix.length).replace(/\.$/u, ""));
}

function exactRef(value) {
  requireArgument(value && typeof value.view_id === "string" && Number.isInteger(value.revision), "expected exact View ref");
  return { view_id: value.view_id, revision: value.revision };
}

function sameRef(left, right) {
  return left.view_id === right.view_id && left.revision === right.revision;
}

function requireArgument(condition, message) {
  if (!condition) throw new Error(message);
}

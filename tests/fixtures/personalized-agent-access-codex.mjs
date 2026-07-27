#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const fixtureMode = basename(process.argv[1]);
if (fixtureMode.includes("ignore-sigterm") || fixtureMode.includes("output-overflow")) {
  process.on("SIGTERM", () => {});
  if (fixtureMode.includes("output-overflow")) process.stdout.write("x".repeat(1_100_000));
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const args = process.argv.slice(2);
requireArgument(args[0] === "exec", "expected codex exec");
requireFlag(args, "--json");
requireFlag(args, "--ephemeral");
requireFlagValue(args, "--sandbox", "read-only");
requireFlag(args, "--ignore-user-config");
requireFlag(args, "--ignore-rules");
requireFlag(args, "--strict-config");
requireFlag(args, "--output-schema");
requireFlag(args, "--output-last-message");
requireArgument(realpathSync(requireFlag(args, "--cd")) === realpathSync(process.cwd()), "--cd value is invalid");
requireArgument(args.at(-1) === "-", "prompt must arrive through stdin");

const prompt = readFileSync(0, "utf8");
requireArgument(prompt.includes("Use $metaflow-view-access"), "staged skill was not explicitly invoked");
requireArgument(prompt.includes("Use only the configured Metaflow MCP read tools"), "read-only MCP instruction is missing");
const skill = readFileSync(join(process.cwd(), ".agents", "skills", "metaflow-view-access", "SKILL.md"), "utf8");
requireArgument(skill.includes("Never open Metaflow SQLite"), "staged skill safety rule is missing");

const workingQuery = promptValue(prompt, "Search for the working-state View with this literal query: ");
const applicationQuery = promptValue(prompt, "Search for the Application Space with this literal query: ");
const workingExpected = promptValue(prompt, "EXPECTED_WORKING_STATE_REF_JSON: ");
const applicationExpected = promptValue(prompt, "EXPECTED_APPLICATION_SPACE_REF_JSON: ");

if (fixtureMode.includes("adversarial")) {
  await expectScopeDenied("view.search", searchInput("Unapproved broad search"));
  await expectScopeDenied("view.get", { ref: { view_id: "view:undeclared:private", revision: 1 } });
  await expectScopeDenied("view.graph.project", {
    request: {
      roots: [workingExpected],
      direction: "outgoing",
      edge_types: ["application_composition", "application_member"],
      max_depth: 1,
      max_nodes: 10,
      max_edges: 20,
    },
  });
}

call(["--json", "doctor"]);
const workingSearch = search(workingQuery);
const workingRef = exactRef(workingSearch.data?.hits?.[0]?.ref);
requireArgument(sameRef(workingRef, workingExpected), "working-state Search selected an unexpected exact ref");
const working = call(["--json", "view.get", "--input", JSON.stringify({ ref: workingRef })]);
requireArgument(working.ok, "working-state exact read failed");

const applicationSearch = search(applicationQuery);
const applicationRef = exactRef(applicationSearch.data?.hits?.[0]?.ref);
requireArgument(sameRef(applicationRef, applicationExpected), "Application Space Search selected an unexpected exact ref");
const application = call(["--json", "view.get", "--input", JSON.stringify({ ref: applicationRef })]);
requireArgument(application.ok, "Application Space exact read failed");

const graph = call(["--json", "view.graph.project", "--input", JSON.stringify({
  request: {
    roots: [applicationRef],
    direction: "outgoing",
    edge_types: ["application_composition", "application_member"],
    max_depth: 1,
    max_nodes: 10,
    max_edges: 20,
  },
})]);
requireArgument(graph.ok && Array.isArray(graph.data?.nodes), "bounded graph projection failed");
const graphRefs = graph.data.nodes.map(node => exactRef(node.ref));
requireArgument(graphRefs.some(ref => sameRef(ref, workingRef)), "graph omitted working-state exact ref");
requireArgument(graphRefs.some(ref => sameRef(ref, applicationRef)), "graph omitted Application Space exact ref");

const result = JSON.stringify({
  working_state_ref: workingRef,
  application_space_ref: applicationRef,
  graph_refs: graphRefs,
});
writeFileSync(requireFlag(args, "--output-last-message"), result);
process.stdout.write(`${result}\n`);

function search(query) {
  return call(["--json", "view.search", "--input", JSON.stringify(searchInput(query))]);
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

async function expectScopeDenied(operation, input) {
  const response = await fetch(new URL(
    `/metaflow/v1/operations/${encodeURIComponent(operation)}`,
    process.env.METAFLOW_DAEMON_URL,
  ), {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.METAFLOW_AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const envelope = await response.json();
  requireArgument(
    envelope.ok === false && envelope.error?.code === "agent_acceptance_scope_denied",
    `${operation} adversarial request was not denied before execution`,
  );
}

function call(operationArgs) {
  const stdout = execFileSync("mf", operationArgs, { encoding: "utf8", env: process.env });
  const lines = stdout.trim().split("\n");
  requireArgument(lines.length === 1, "mf must emit one JSON envelope");
  return JSON.parse(lines[0]);
}

function promptValue(promptValue, prefix, occurrence = 0) {
  const lines = promptValue.split("\n").filter(line => line.startsWith(prefix));
  requireArgument(lines.length > occurrence, `prompt is missing ${prefix}`);
  const suffix = lines[occurrence].slice(prefix.length).replace(/\.$/u, "");
  return JSON.parse(suffix);
}

function exactRef(value) {
  requireArgument(value && typeof value.view_id === "string" && Number.isInteger(value.revision), "expected exact View ref");
  return { view_id: value.view_id, revision: value.revision };
}

function sameRef(left, right) {
  return left.view_id === right.view_id && left.revision === right.revision;
}

function requireFlag(argv, flag) {
  const index = argv.indexOf(flag);
  requireArgument(index >= 0, `missing ${flag}`);
  return argv[index + 1];
}

function requireFlagValue(argv, flag, expected) {
  requireArgument(requireFlag(argv, flag) === expected, `${flag} value is invalid`);
}

function requireArgument(condition, message) {
  if (!condition) throw new Error(message);
}

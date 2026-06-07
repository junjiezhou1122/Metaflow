import test from "node:test";
import assert from "node:assert/strict";
import { filterViewsByQuery, viewMatchesQuery } from "@info/core";

const agentOutputView = {
  id: "analysis:agent-output",
  view_type: "analysis.browser_agent_task",
  title: "Browser AgentTask output",
  content: {
    agent_output: {
      summary: "Browser analysis",
      analysis: "This output explains vectorized context routing for ambient agents.",
      key_points: ["context routing", "ambient agent"],
    },
  },
};

test("viewMatchesQuery matches standardized agent_output content", () => {
  assert.equal(viewMatchesQuery(agentOutputView, "vectorized"), true);
  assert.equal(viewMatchesQuery(agentOutputView, "ambient"), true);
  assert.equal(viewMatchesQuery(agentOutputView, "unrelated"), false);
});

test("viewMatchesQuery treats empty query as match", () => {
  assert.equal(viewMatchesQuery(agentOutputView, undefined), true);
  assert.equal(viewMatchesQuery(agentOutputView, "   "), true);
});

test("filterViewsByQuery matches any query term across View fields", () => {
  const views = [
    agentOutputView,
    {
      id: "analysis:repo",
      view_type: "analysis.repo",
      title: "Repository setup",
      content: { analysis: "Package installation notes." },
    },
  ];

  assert.deepEqual(filterViewsByQuery(views, "package vectorized").map(view => view.id), ["analysis:agent-output", "analysis:repo"]);
  assert.deepEqual(filterViewsByQuery(views, "missing").map(view => view.id), []);
});

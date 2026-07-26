import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("runtime UI prioritizes canonical Agent Surface view families", () => {
  const main = readFileSync("apps/ui/src/main.tsx", "utf8");
  const explorer = readFileSync("apps/ui/src/components/ViewExplorer.tsx", "utf8");
  const projectDashboard = readFileSync("apps/ui/src/components/ProjectDashboard.tsx", "utf8");
  const api = readFileSync("apps/ui/src/api.ts", "utf8");

  assert.match(main, /"state\.surface", "work\.focus_set", "project\.current", "memory\.daily", "memory\.profile"/);
  assert.match(main, /Agent Surface Views/);
  assert.match(main, /Surface → Focus Set → Project Current → Daily\/Profile Memory/);
  assert.match(main, /function prioritizeAgentSurfaceTypes/);

  assert.match(explorer, /const AGENT_SURFACE_VIEW_ORDER = \["state\.surface", "work\.focus_set", "project\.current", "memory\.daily", "memory\.profile"\]/);
  assert.match(explorer, /useState<string>\("state\.surface"\)/);
  assert.match(explorer, /"memory\.profile": "Memory Profile"/);
  assert.match(explorer, /function viewPrimaryMetricLabel/);
  assert.match(explorer, /isAgentSurfaceView\(type\) \? "Sources" : "Confidence"/);

  assert.match(projectDashboard, /sourceSummary\(project\)/);
  assert.match(projectDashboard, /function sourceSummary/);

  assert.match(api, /view_types=project\.current,project\.current_context/);
  assert.match(api, /a\.view_type === "project\.current"/);
});

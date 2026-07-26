import { describe, it } from "node:test";
import assert from "node:assert";
import type { ContextViewSummary, MemoryCandidateContent, MemoryGateDecision, ProjectCurrentContent, ProcessorRun, WorkFocusLane, WorkFocusSetContent } from "../apps/ui/src/types.js";

function readSource(path: string) {
  return import("node:fs").then(fs => fs.readFileSync(path, "utf-8"));
}

describe("UI View, Memory, and Processor surfaces", () => {
  describe("types", () => {
    it("MemoryCandidateContent type exists", () => {
      const content: MemoryCandidateContent = {
        memory_kind: "preference",
        target_view_type: "memory.preferences",
        claim: "test",
        confidence: 0.9,
        evidence_count: 1,
        promotion_policy: {
          min_confidence: 0.7,
          min_evidence_count: 1,
          allow_manual_promote: true,
          require_privacy_check: true,
        },
      };
      assert.strictEqual(content.claim, "test");
    });

    it("MemoryGateDecision type exists", () => {
      const decision: MemoryGateDecision = { action: "promote", candidate_id: "x", target_view_type: "memory.preferences", confidence: 0.9 };
      assert.strictEqual(decision.action, "promote");
    });

    it("ProjectCurrentContent type exists", () => {
      const content: ProjectCurrentContent = { decisions: [] };
      assert.deepStrictEqual(content.decisions, []);
    });

    it("WorkFocusSetContent type exists", () => {
      const lane: WorkFocusLane = {
        lane_key: "test",
        lane_kind: "project",
        label: "Test",
        attention_share: 0.5,
        confidence: 0.8,
        source_records: [],
        candidate_route_ids: [],
        route_scores: [],
        evidence: {},
      };
      assert.strictEqual(lane.label, "Test");
    });

    it("ProcessorRun type exists", () => {
      const run: ProcessorRun = {
        processor_id: "test",
        runtime: "local",
        ok: true,
        source: { kind: "observation" },
        view_drafts: 1,
        views_written: [],
        diagnostics: {},
      };
      assert.strictEqual(run.ok, true);
    });
  });

  describe("api client helpers (existence only)", () => {
    it("api module exports new helpers without crash", async () => {
      // The api module accesses import.meta.env on load, which will fail in Node.
      // We verify the module structure by reading the source.
      const source = await readSource("./apps/ui/src/api.ts");
      assert.ok(source.includes("export async function fetchMemoryCandidates"));
      assert.ok(source.includes("export async function fetchMemoryGateViews"));
      assert.ok(source.includes("export async function fetchProjectCurrentViews"));
      assert.ok(source.includes("export async function fetchWorkFocusSetViews"));
      assert.ok(source.includes("export async function fetchProcessorTraces"));
      assert.ok(source.includes("export async function fetchProactiveSuggestions"));
    });
  });

  describe("components import and export correctly", () => {
    it("ViewExplorer component exists", async () => {
      const source = await readSource("./apps/ui/src/components/ViewExplorer.tsx");
      assert.ok(source.includes("export default function ViewExplorer"));
    });

    it("MemoryReviewInbox component exists", async () => {
      const source = await readSource("./apps/ui/src/components/MemoryReviewInbox.tsx");
      assert.ok(source.includes("export default function MemoryReviewInbox"));
    });

    it("ProjectDashboard component exists", async () => {
      const source = await readSource("./apps/ui/src/components/ProjectDashboard.tsx");
      assert.ok(source.includes("export default function ProjectDashboard"));
    });

    it("ProcessorTracesPanel component exists", async () => {
      const source = await readSource("./apps/ui/src/components/ProcessorTracesPanel.tsx");
      assert.ok(source.includes("export default function ProcessorTracesPanel"));
    });

    it("ProactiveInbox component exists", async () => {
      const source = await readSource("./apps/ui/src/components/ProactiveInbox.tsx");
      assert.ok(source.includes("export default function ProactiveInbox"));
    });
  });

  describe("workbench affordances", () => {
    it("proactive agent panels expose refresh, status, and empty-state UI", async () => {
      const files = [
        "./apps/ui/src/components/ViewExplorer.tsx",
        "./apps/ui/src/components/ProjectDashboard.tsx",
        "./apps/ui/src/components/MemoryReviewInbox.tsx",
        "./apps/ui/src/components/ProcessorTracesPanel.tsx",
        "./apps/ui/src/components/ProactiveInbox.tsx",
      ];
      for (const file of files) {
        const source = await readSource(file);
        assert.ok(source.includes("WorkbenchHeader"), `${file} should render a workbench header`);
        assert.ok(source.includes("workbench-metrics"), `${file} should render dense summary metrics`);
        assert.ok(source.includes("EmptyState"), `${file} should render an explicit empty state`);
        assert.ok(source.includes("error"), `${file} should track request errors separately from status`);
        assert.ok(source.includes("Refresh"), `${file} should expose refresh affordance`);
      }
    });

    it("actionable inbox rows do not nest action buttons inside the inspect button", async () => {
      const memorySource = await readSource("./apps/ui/src/components/MemoryReviewInbox.tsx");
      const proactiveSource = await readSource("./apps/ui/src/components/ProactiveInbox.tsx");
      assert.ok(memorySource.includes("<article"));
      assert.ok(memorySource.includes("className=\"workbench-row-main\""));
      assert.ok(proactiveSource.includes("<article"));
      assert.ok(proactiveSource.includes("className=\"workbench-row-main\""));
    });
  });
});

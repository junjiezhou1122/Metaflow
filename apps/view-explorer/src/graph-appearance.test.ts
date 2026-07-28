import assert from "node:assert/strict";
import test from "node:test";
import Graph from "graphology";
import { assertGraphNodeLoaded, reduceEdgeAppearance, reduceNodeAppearance } from "./graph-appearance.js";

test("missing Sigma hover nodes fail with observable graph identity", () => {
  const graph = new Graph();
  assert.throws(() => assertGraphNodeLoaded(graph, "view:missing@1"), /Sigma entered missing graph node view:missing@1/);
});

test("hovered neighborhood temporarily overrides and restores selected appearance", () => {
  const graph = new Graph({ multi: true, type: "directed" });
  for (const key of ["selected", "hovered", "neighbor", "unrelated"]) {
    graph.addNode(key, { color: "#4263a9", label: key, size: 4, zIndex: 0 });
  }
  graph.addDirectedEdgeWithKey("hover-edge", "hovered", "neighbor", { relationType: "derived_from", color: "#999", size: 0.7 });
  graph.addDirectedEdgeWithKey("unrelated-edge", "selected", "unrelated", { relationType: "references", color: "#999", size: 0.7 });

  const selectedBefore = reduceNodeAppearance(graph, "selected", graph.getNodeAttributes("selected"), { selectedKey: "selected" });
  assert.equal(selectedBefore.color, "#6558d9");
  assert.equal(selectedBefore.size, 6);

  const hovered = reduceNodeAppearance(graph, "hovered", graph.getNodeAttributes("hovered"), { selectedKey: "selected", hoveredKey: "hovered" });
  const neighbor = reduceNodeAppearance(graph, "neighbor", graph.getNodeAttributes("neighbor"), { selectedKey: "selected", hoveredKey: "hovered" });
  const unrelated = reduceNodeAppearance(graph, "selected", graph.getNodeAttributes("selected"), { selectedKey: "selected", hoveredKey: "hovered" });
  assert.equal(hovered.color, "#6558d9");
  assert.equal(hovered.size, 6.2);
  assert.equal(hovered.highlighted, true);
  assert.equal(hovered.forceLabel, true);
  assert.equal(neighbor.forceLabel, undefined);
  assert.equal(neighbor.color, "#505553");
  assert.equal(neighbor.size, 4.48);
  assert.equal(unrelated.color, "#d9dcda");
  assert.equal(unrelated.label, "");

  const incidentEdge = reduceEdgeAppearance(graph, "hover-edge", graph.getEdgeAttributes("hover-edge"), { selectedKey: "selected", hoveredKey: "hovered" });
  const unrelatedEdge = reduceEdgeAppearance(graph, "unrelated-edge", graph.getEdgeAttributes("unrelated-edge"), { selectedKey: "selected", hoveredKey: "hovered" });
  assert.equal(incidentEdge.color, "#6558d9");
  assert.equal(incidentEdge.size, 1.9);
  assert.equal(unrelatedEdge.color, "#e5e7e5");
  assert.equal(unrelatedEdge.size, 0.3);

  const selectedAfter = reduceNodeAppearance(graph, "selected", graph.getNodeAttributes("selected"), { selectedKey: "selected" });
  const selectedEdgeAfter = reduceEdgeAppearance(graph, "unrelated-edge", graph.getEdgeAttributes("unrelated-edge"), { selectedKey: "selected" });
  assert.deepEqual(selectedAfter, selectedBefore);
  assert.equal(selectedEdgeAfter.color, "#6558d9");
  assert.equal(selectedEdgeAfter.size, 1.65);
});

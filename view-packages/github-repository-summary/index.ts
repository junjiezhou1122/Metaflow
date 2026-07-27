import { defineViewPackage } from "@info/view-package";

export const githubRepositorySummarySchema = {
  name: "summary.github.repository",
  version: 1,
  mode: "freeform",
} as const;

export const githubRepositorySummarySchemaKey = {
  name: githubRepositorySummarySchema.name,
  version: githubRepositorySummarySchema.version,
} as const;

export const githubRepositorySummaryViewPackage = defineViewPackage({
  manifest_version: 1,
  id: "view-package.github.repository-summary",
  version: 1,
  name: "GitHub Repository Summary",
  description: "Human and Agent projections for summaries derived from exact GitHub repository page evidence.",
  schemas: [githubRepositorySummarySchema],
  representations: [{
    id: "representation.github.repository-summary.agent-output",
    schema: githubRepositorySummarySchemaKey,
    forms: ["inline"],
    kinds: ["agent_output"],
    media_types: [],
  }],
  materializations: [{
    id: "materialization.github.repository-summary.json",
    schema: githubRepositorySummarySchemaKey,
    formats: ["json"],
    media_types: ["application/json"],
    locations: ["inline", "uri", "content_addressed"],
  }],
  renderers: [{
    id: "renderer.github.repository-summary",
    version: 1,
    abi_version: 1,
    schema: githubRepositorySummarySchemaKey,
    surfaces: ["web", "generic"],
    representation_kinds: ["agent_output"],
    priority: 100,
  }],
  processors: [{
    id: "processor.github.repository-summary",
    version: 1,
    inputs: [
      {
        role: "current_page",
        schemas: [{ name: "capture.browser.page_snapshot", version: 1 }],
        required: true,
      },
      {
        role: "current_selection",
        schemas: [{ name: "capture.browser.selection", version: 1 }],
        required: false,
      },
    ],
    output_schema: githubRepositorySummarySchemaKey,
    transformation: { transformation_id: "transformation.github.repository_summary", revision: 1 },
    priority: 100,
  }],
  methods: [
    {
      id: "inspect",
      description: "Read one exact repository summary View.",
      schema: githubRepositorySummarySchemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.get" },
    },
    {
      id: "related",
      description: "Traverse exact evidence and derived relations for this summary.",
      schema: githubRepositorySummarySchemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.traverse" },
    },
    {
      id: "regenerate",
      description: "Create a new summary through the exact repository-summary Transformation.",
      schema: githubRepositorySummarySchemaKey,
      effect: "creates_view",
      target: {
        kind: "transformation",
        transformation: { transformation_id: "transformation.github.repository_summary", revision: 1 },
      },
    },
  ],
  evolutions: [],
});

export const githubRepositorySummaryFixtures = [{
  id: "fixture.github.repository-summary.codex",
  schema: githubRepositorySummarySchemaKey,
  representation: {
    form: "inline",
    kind: "agent_output",
    value: {
      summary: "Codex is an open-source coding agent.",
      key_points: ["Runs coding tasks", "Keeps exact source provenance"],
    },
    metadata: {},
  },
}] as const;

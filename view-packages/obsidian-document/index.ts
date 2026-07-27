import { defineViewPackage } from "@info/view-package";

export const obsidianDocumentSchema = {
  name: "capture.obsidian.document",
  version: 1,
  mode: "freeform",
} as const;

export const obsidianDocumentSchemaKey = {
  name: obsidianDocumentSchema.name,
  version: obsidianDocumentSchema.version,
} as const;

export const fragmentSetSchemaKey = {
  name: "metaflow.view.fragment-set",
  version: 1,
} as const;

export const obsidianDocumentViewPackage = defineViewPackage({
  manifest_version: 1,
  id: "view-package.obsidian.document",
  version: 1,
  name: "Obsidian Markdown Document",
  description: "Exact captured Obsidian documents with a discoverable Markdown Parser Transformation.",
  schemas: [obsidianDocumentSchema],
  representations: [{
    id: "representation.obsidian.markdown-document",
    schema: obsidianDocumentSchemaKey,
    forms: ["inline"],
    kinds: ["obsidian_markdown_document"],
    media_types: ["text/markdown"],
  }],
  materializations: [{
    id: "materialization.obsidian.markdown",
    schema: obsidianDocumentSchemaKey,
    formats: ["markdown", "json"],
    media_types: ["text/markdown", "application/json"],
    locations: ["inline", "content_addressed"],
  }],
  parsers: [{
    id: "parser.markdown",
    version: 1,
    abi_version: 1,
    input_schema: obsidianDocumentSchemaKey,
    accepts: {
      forms: ["inline"],
      representation_kinds: ["obsidian_markdown_document"],
      media_types: ["text/markdown"],
    },
    transformation: { transformation_id: "transformation.parser.markdown", revision: 1 },
    output_schema: fragmentSetSchemaKey,
    priority: 100,
  }],
  methods: [
    {
      id: "inspect",
      description: "Read one exact captured Obsidian document View.",
      schema: obsidianDocumentSchemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.get" },
    },
    {
      id: "search",
      description: "Search this exact document or its committed parser projections.",
      schema: obsidianDocumentSchemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.search" },
    },
  ],
});

export const obsidianDocumentFixtures = [{
  id: "fixture.obsidian.document.english-learning",
  schema: obsidianDocumentSchemaKey,
  representation: {
    form: "inline",
    kind: "obsidian_markdown_document",
    media_type: "text/markdown; charset=utf-8",
    value: {
      vault_id: "vault:learning",
      document_id: "document:english-learning",
      relative_path: "Learning/English.md",
      revision: {
        sha256: "5a158f265a25020c6e5192f5f6209d14ad65e90212afce16e518fd848a070d5a",
        byte_length: 38,
        mtime_ms: 1_785_130_000_000,
      },
      markdown: "# English learning\n\nReview exact phrases.",
      frontmatter: null,
      headings: [],
      links: [],
    },
    metadata: {},
  },
}] as const;

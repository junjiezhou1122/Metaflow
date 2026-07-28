import test from "node:test";
import assert from "node:assert/strict";
import {
  ViewPackageCatalog,
  ViewPackageError,
  defineViewPackage,
  runViewPackageConformance,
} from "@info/view-package";
import { exactTransformationRef } from "@info/transformation";
import { obsidianMarkdownParserTransformation } from "../apps/ambient-daemon/definitions.ts";
import {
  githubRepositorySummaryFixtures,
  githubRepositorySummarySchema,
  githubRepositorySummarySchemaKey,
  githubRepositorySummaryViewPackage,
} from "../view-packages/github-repository-summary/index.ts";
import {
  obsidianDocumentFixtures,
  obsidianDocumentSchemaKey,
  obsidianDocumentViewPackage,
} from "../view-packages/obsidian-document/index.ts";
import {
  SCREENPIPE_TIMELINE_INDEX_SCHEMA,
  screenpipeTimelineFixtures,
  screenpipeTimelineViewPackage,
} from "@info/view-package-screenpipe-timeline";

const environment = {
  operations: new Set(["view.get", "view.traverse", "run.execute"]),
  renderers: new Set(["renderer.github.repository-summary@1@1"]),
  transformations: new Map([[
    "transformation.github.repository_summary@1",
    {
      ref: { transformation_id: "transformation.github.repository_summary", revision: 1 },
      output_schema: githubRepositorySummarySchema,
      input_roles: [
        { role: "current_page", required: true, schemas: [{ name: "capture.browser.page_snapshot", version: 1 }] },
        { role: "current_selection", required: false, schemas: [{ name: "capture.browser.selection", version: 1 }] },
      ],
    },
  ]]),
};

const markdownTransformation = {
  ref: exactTransformationRef(obsidianMarkdownParserTransformation),
  output_schema: obsidianMarkdownParserTransformation.output.schema,
  input_roles: [{ role: "source", required: true, schemas: [obsidianDocumentSchemaKey] }],
} as const;

const obsidianEnvironment = {
  operations: new Set(["view.get", "view.search"]),
  renderers: new Set<string>(),
  transformations: new Map([["transformation.parser.markdown@1", markdownTransformation]]),
};

test("one View Package binds Schema, Materialization, human Renderer, and Agent Methods", () => {
  const report = runViewPackageConformance({
    package: githubRepositorySummaryViewPackage,
    fixtures: githubRepositorySummaryFixtures,
    ...environment,
  });

  assert.deepEqual(report, {
    package_id: "view-package.github.repository-summary",
    package_version: 1,
    schemas: 1,
    fixtures: 1,
    methods: 3,
    renderers: 1,
    parsers: 0,
    processors: 1,
    evolutions: 0,
  });
  assert.equal(githubRepositorySummaryViewPackage.schema(githubRepositorySummarySchemaKey).mode, "freeform");
  assert.equal(githubRepositorySummaryViewPackage.renderers(githubRepositorySummarySchemaKey, "web")[0]?.id,
    "renderer.github.repository-summary");
  assert.equal(githubRepositorySummaryViewPackage.renderers(githubRepositorySummarySchemaKey, "web")[0]?.abi_version, 1);
  assert.equal(githubRepositorySummaryViewPackage.method("regenerate")?.effect, "creates_view");
});

test("Screenpipe Timeline Package declares a strict cursor-paged typed query Method", () => {
  const report = runViewPackageConformance({
    package: screenpipeTimelineViewPackage,
    fixtures: screenpipeTimelineFixtures,
    operations: new Set(["view.get", "view.query", "capture.connection.run"]),
    renderers: new Set(["renderer.screenpipe.timeline@1@1"]),
    transformations: new Map(),
  });
  assert.deepEqual(report, {
    package_id: "view-package.screenpipe-timeline",
    package_version: 1,
    schemas: 1,
    fixtures: 1,
    methods: 3,
    renderers: 1,
    parsers: 0,
    processors: 0,
    evolutions: 0,
  });
  assert.equal(screenpipeTimelineViewPackage.schema({
    name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name,
    version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version,
  }).mode, "strict");
  const entries = screenpipeTimelineViewPackage.method("entries");
  assert.deepEqual(entries?.target, { kind: "operation", operation: "view.query" });
  assert.equal(entries?.parameters?.dialect, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(entries?.parameters?.pagination, { kind: "cursor", max_page_size: 100 });
  assert.deepEqual(screenpipeTimelineViewPackage.method("refresh")?.target, {
    kind: "operation",
    operation: "capture.connection.run",
  });
});

test("View Package catalog discovers Schema owners and rejects duplicate registration", () => {
  const catalog = new ViewPackageCatalog();
  catalog.register(githubRepositorySummaryViewPackage);

  assert.deepEqual(catalog.get("view-package.github.repository-summary", 1).manifest,
    githubRepositorySummaryViewPackage.manifest);
  assert.deepEqual(catalog.latest("view-package.github.repository-summary")?.manifest,
    githubRepositorySummaryViewPackage.manifest);
  assert.deepEqual(catalog.forSchema(githubRepositorySummarySchemaKey).map(item => item.manifest),
    [githubRepositorySummaryViewPackage.manifest]);
  assert.throws(
    () => catalog.register(githubRepositorySummaryViewPackage),
    (error: unknown) => error instanceof ViewPackageError && error.code === "duplicate_package",
  );
});

test("View Package definitions are deeply immutable and catalog registration rejects conflicting Parser identities", () => {
  assert.throws(() => {
    (obsidianDocumentViewPackage.manifest.parsers[0]!.transformation as { revision: number }).revision = 2;
  }, TypeError);

  const catalog = new ViewPackageCatalog();
  catalog.register(obsidianDocumentViewPackage);
  const conflict = defineViewPackage({
    ...obsidianDocumentViewPackage.manifest,
    id: "view-package.obsidian.document.parser-conflict",
    parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({
      ...parser,
      transformation: { ...parser.transformation, revision: parser.transformation.revision + 1 },
    })),
  });
  assert.throws(
    () => catalog.register(conflict),
    (error: unknown) => error instanceof ViewPackageError && error.code === "duplicate_parser",
  );
  assert.equal(catalog.list().length, 1);
});

test("Parser discovery matches MIME essence and resolves one exact Transformation descriptor", () => {
  const report = runViewPackageConformance({
    package: obsidianDocumentViewPackage,
    fixtures: obsidianDocumentFixtures,
    ...obsidianEnvironment,
  });
  assert.deepEqual(report, {
    package_id: "view-package.obsidian.document",
    package_version: 1,
    schemas: 1,
    fixtures: 1,
    methods: 2,
    renderers: 0,
    parsers: 1,
    processors: 0,
    evolutions: 0,
  });

  const catalog = new ViewPackageCatalog();
  catalog.register(obsidianDocumentViewPackage);
  const parser = catalog.resolveParser(obsidianDocumentSchemaKey, {
    form: "inline",
    kind: "obsidian_markdown_document",
    media_type: "Text/Markdown; Charset=UTF-8",
    value: { markdown: "# Exact source" },
    metadata: {},
  });
  assert.equal(parser.id, "parser.markdown");
  assert.deepEqual(parser.transformation, { transformation_id: "transformation.parser.markdown", revision: 1 });
  assert.deepEqual(obsidianDocumentViewPackage.parsers(obsidianDocumentSchemaKey), [parser]);
  assert.deepEqual(githubRepositorySummaryViewPackage.processors(githubRepositorySummarySchemaKey),
    githubRepositorySummaryViewPackage.manifest.processors);
});

test("Parser discovery fails explicitly when no parser matches or top priority is ambiguous", () => {
  const catalog = new ViewPackageCatalog();
  catalog.register(obsidianDocumentViewPackage);
  const malformedRepresentation = {
    form: "inline" as const,
    kind: "obsidian_markdown_document",
    media_type: "; input=bad",
    value: {},
    metadata: {},
  };
  assert.throws(
    () => obsidianDocumentViewPackage.parsers(obsidianDocumentSchemaKey, malformedRepresentation),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_representation_media_type",
  );
  assert.throws(
    () => catalog.resolveParser(obsidianDocumentSchemaKey, malformedRepresentation),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_representation_media_type",
  );
  assert.throws(
    () => catalog.resolveParser(obsidianDocumentSchemaKey, {
      form: "inline",
      kind: "obsidian_markdown_document",
      media_type: "application/pdf",
      value: {},
      metadata: {},
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "missing_parser",
  );

  const preferredCatalog = new ViewPackageCatalog();
  preferredCatalog.register(obsidianDocumentViewPackage);
  preferredCatalog.register(defineViewPackage({
    ...obsidianDocumentViewPackage.manifest,
    id: "view-package.obsidian.document.preferred-parser",
    parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({
      ...parser,
      id: "parser.markdown.preferred",
      priority: parser.priority + 100,
    })),
  }));
  assert.equal(
    preferredCatalog.resolveParser(obsidianDocumentSchemaKey, obsidianDocumentFixtures[0].representation).id,
    "parser.markdown.preferred",
  );

  catalog.register(defineViewPackage({
    ...obsidianDocumentViewPackage.manifest,
    id: "view-package.obsidian.document.alternative-parser",
    parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({
      ...parser,
      id: "parser.markdown.alternative",
    })),
  }));
  assert.throws(
    () => catalog.resolveParser(obsidianDocumentSchemaKey, obsidianDocumentFixtures[0].representation),
    (error: unknown) => error instanceof ViewPackageError && error.code === "ambiguous_parser",
  );
});

test("View Package conformance fails on unavailable implementations and output drift", () => {
  assert.throws(
    () => runViewPackageConformance({
      package: githubRepositorySummaryViewPackage,
      fixtures: githubRepositorySummaryFixtures,
      ...environment,
      renderers: new Set(),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "missing_renderer",
  );

  assert.throws(
    () => runViewPackageConformance({
      package: githubRepositorySummaryViewPackage,
      fixtures: githubRepositorySummaryFixtures,
      ...environment,
      transformations: new Map([[
        "transformation.github.repository_summary@1",
        {
          ref: { transformation_id: "transformation.github.repository_summary", revision: 1 },
          output_schema: { name: "summary.github.repository", version: 2 },
          input_roles: [
            { role: "current_page", required: true, schemas: [{ name: "capture.browser.page_snapshot", version: 1 }] },
            { role: "current_selection", required: false, schemas: [{ name: "capture.browser.selection", version: 1 }] },
          ],
        },
      ]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_output_mismatch",
  );
});

test("Parser conformance rejects incomplete fixture coverage and Transformation contract drift", () => {
  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: [{
        ...obsidianDocumentFixtures[0],
        representation: { ...obsidianDocumentFixtures[0].representation, media_type: "; fixture=bad" },
      }],
      ...obsidianEnvironment,
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_fixture",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: [],
      ...obsidianEnvironment,
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "missing_parser_fixture",
  );

  assert.throws(
    () => defineViewPackage({
      ...obsidianDocumentViewPackage.manifest,
      id: "view-package.obsidian.document.profile-drift",
      parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({
        ...parser,
        accepts: { ...parser.accepts, media_types: ["application/pdf"] },
      })),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
  );

  const uncoveredFixture = defineViewPackage({
    ...obsidianDocumentViewPackage.manifest,
    id: "view-package.obsidian.document.uncovered-fixture",
    representations: obsidianDocumentViewPackage.manifest.representations.map(profile => ({
      ...profile,
      kinds: [...profile.kinds, "obsidian_markdown_note"],
    })),
    parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({
      ...parser,
      accepts: {
        ...parser.accepts,
        representation_kinds: [...parser.accepts.representation_kinds, "obsidian_markdown_note"],
      },
    })),
  });
  assert.throws(
    () => runViewPackageConformance({
      package: uncoveredFixture,
      fixtures: obsidianDocumentFixtures,
      ...obsidianEnvironment,
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "missing_parser_fixture",
  );

  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: obsidianDocumentFixtures,
      ...obsidianEnvironment,
      transformations: new Map(),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "missing_transformation",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: obsidianDocumentFixtures,
      ...obsidianEnvironment,
      transformations: new Map([["transformation.parser.markdown@1", {
        ...markdownTransformation,
        output_schema: { name: "metaflow.view.fragment-set", version: 2 },
      }]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_output_mismatch",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: obsidianDocumentFixtures,
      ...obsidianEnvironment,
      transformations: new Map([["transformation.parser.markdown@1", {
        ...markdownTransformation,
        ref: { transformation_id: "transformation.parser.markdown", revision: 99 },
      }]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_reference_mismatch",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: obsidianDocumentFixtures,
      ...obsidianEnvironment,
      transformations: new Map([["transformation.parser.markdown@1", {
        ...markdownTransformation,
        input_roles: [{ role: "documents", required: true, schemas: [obsidianDocumentSchemaKey] }],
      }]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_input_mismatch",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: obsidianDocumentViewPackage,
      fixtures: obsidianDocumentFixtures,
      ...obsidianEnvironment,
      transformations: new Map([["transformation.parser.markdown@1", {
        ...markdownTransformation,
        input_roles: [{
          role: "source",
          required: true,
          schemas: [{ name: "capture.obsidian.attachment", version: 1 }],
        }],
      }]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_input_mismatch",
  );
});

test("Processor conformance rejects role drift from the exact Transformation", () => {
  assert.throws(
    () => runViewPackageConformance({
      package: githubRepositorySummaryViewPackage,
      fixtures: githubRepositorySummaryFixtures,
      ...environment,
      transformations: new Map([["transformation.github.repository_summary@1", {
        ...environment.transformations.get("transformation.github.repository_summary@1")!,
        input_roles: [{
          role: "current_page",
          required: true,
          schemas: [{ name: "capture.browser.page_snapshot", version: 1 }],
        }],
      }]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_input_mismatch",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: githubRepositorySummaryViewPackage,
      fixtures: githubRepositorySummaryFixtures,
      ...environment,
      transformations: new Map([["transformation.github.repository_summary@1", {
        ...environment.transformations.get("transformation.github.repository_summary@1")!,
        input_roles: [
          {
            role: "current_page",
            required: true,
            schemas: [{ name: "capture.browser.navigation", version: 1 }],
          },
          {
            role: "current_selection",
            required: false,
            schemas: [{ name: "capture.browser.selection", version: 1 }],
          },
        ],
      }]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_input_mismatch",
  );
});

test("View Package manifest and strict fixtures fail fast", () => {
  assert.throws(
    () => defineViewPackage({
      ...githubRepositorySummaryViewPackage.manifest,
      id: "view-package.renderer-without-abi",
      renderers: githubRepositorySummaryViewPackage.manifest.renderers.map(({ abi_version: _abi, ...renderer }) => renderer),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
  );

  for (const invalidMediaType of ["; profile=bad", "text", "/markdown", "text/"]) {
    assert.throws(
      () => defineViewPackage({
        ...obsidianDocumentViewPackage.manifest,
        id: `view-package.invalid-media.${invalidMediaType.length}`,
        representations: obsidianDocumentViewPackage.manifest.representations.map(profile => ({
          ...profile,
          media_types: [invalidMediaType],
        })),
      }),
      (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
    );
    assert.throws(
      () => defineViewPackage({
        ...obsidianDocumentViewPackage.manifest,
        id: `view-package.invalid-parser-media.${invalidMediaType.length}`,
        parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({
          ...parser,
          accepts: { ...parser.accepts, media_types: [invalidMediaType] },
        })),
      }),
      (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
    );
  }

  assert.throws(
    () => defineViewPackage({
      manifest_version: 1,
      id: "view-package.invalid",
      version: 1,
      name: "Invalid",
      description: "References an undeclared Schema.",
      schemas: [{ name: "declared", version: 1, mode: "freeform" }],
      representations: [{
        id: "representation.invalid",
        schema: { name: "missing", version: 1 },
        forms: ["inline"],
        kinds: ["invalid"],
        media_types: [],
      }],
      materializations: [{
        id: "materialization.invalid",
        schema: { name: "declared", version: 1 },
        formats: ["json"],
        media_types: ["application/json"],
        locations: ["inline"],
      }],
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
  );

  for (const forbidden of [
    { executable: "export default () => null" },
    { entrypoint: "./worker.ts" },
    { url: "https://worker.example.test" },
    { queue: "metaflow-parser-v1" },
  ]) {
    assert.throws(
      () => defineViewPackage({
        ...obsidianDocumentViewPackage.manifest,
        id: `view-package.forbidden.${Object.keys(forbidden)[0]}`,
        parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({ ...parser, ...forbidden })),
      }),
      (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
    );
  }
  assert.throws(
    () => defineViewPackage({
      ...obsidianDocumentViewPackage.manifest,
      id: "view-package.parser-unknown-abi",
      parsers: obsidianDocumentViewPackage.manifest.parsers.map(parser => ({ ...parser, abi_version: 2 })),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_manifest",
  );

  const strict = defineViewPackage({
    manifest_version: 1,
    id: "view-package.strict",
    version: 1,
    name: "Strict fixture",
    description: "Proves fixture validation crosses the View Schema interface.",
    schemas: [{
      name: "strict.example",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    }],
    representations: [{
      id: "representation.strict",
      schema: { name: "strict.example", version: 1 },
      forms: ["inline"],
      kinds: ["strict.example"],
      media_types: [],
    }],
    materializations: [{
      id: "materialization.strict",
      schema: { name: "strict.example", version: 1 },
      formats: ["json"],
      media_types: ["application/json"],
      locations: ["inline"],
    }],
  });
  assert.throws(
    () => runViewPackageConformance({
      package: strict,
      fixtures: [{
        id: "fixture.strict.invalid",
        schema: { name: "strict.example", version: 1 },
        representation: { form: "inline", kind: "strict.example", value: { title: 42 }, metadata: {} },
      }],
      operations: new Set(),
      renderers: new Set(),
      transformations: new Map(),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_fixture",
  );
});

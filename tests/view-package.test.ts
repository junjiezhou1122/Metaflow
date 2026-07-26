import test from "node:test";
import assert from "node:assert/strict";
import {
  ViewPackageCatalog,
  ViewPackageError,
  defineViewPackage,
  runViewPackageConformance,
} from "@info/view-package";
import {
  githubRepositorySummaryFixtures,
  githubRepositorySummarySchema,
  githubRepositorySummarySchemaKey,
  githubRepositorySummaryViewPackage,
} from "../view-packages/github-repository-summary/index.ts";

const environment = {
  operations: new Set(["view.get", "view.traverse", "run.execute"]),
  renderers: new Set(["renderer.github.repository-summary@1@1"]),
  transformations: new Map([[
    "transformation.github.repository_summary@1",
    {
      ref: { transformation_id: "transformation.github.repository_summary", revision: 1 },
      output_schema: githubRepositorySummarySchema,
    },
  ]]),
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
    evolutions: 0,
  });
  assert.equal(githubRepositorySummaryViewPackage.schema(githubRepositorySummarySchemaKey).mode, "freeform");
  assert.equal(githubRepositorySummaryViewPackage.renderers(githubRepositorySummarySchemaKey, "web")[0]?.id,
    "renderer.github.repository-summary");
  assert.equal(githubRepositorySummaryViewPackage.renderers(githubRepositorySummarySchemaKey, "web")[0]?.abi_version, 1);
  assert.equal(githubRepositorySummaryViewPackage.method("regenerate")?.effect, "creates_view");
});

test("View Package catalog discovers Schema owners and rejects duplicate registration", () => {
  const catalog = new ViewPackageCatalog();
  catalog.register(githubRepositorySummaryViewPackage);

  assert.equal(catalog.get("view-package.github.repository-summary", 1), githubRepositorySummaryViewPackage);
  assert.equal(catalog.latest("view-package.github.repository-summary"), githubRepositorySummaryViewPackage);
  assert.deepEqual(catalog.forSchema(githubRepositorySummarySchemaKey), [githubRepositorySummaryViewPackage]);
  assert.throws(
    () => catalog.register(githubRepositorySummaryViewPackage),
    (error: unknown) => error instanceof ViewPackageError && error.code === "duplicate_package",
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
        },
      ]]),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "transformation_output_mismatch",
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
